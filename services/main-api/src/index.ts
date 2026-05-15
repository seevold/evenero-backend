import express, { type Request, Response, NextFunction } from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { registerRoutes } from "./routes";
import { initGoogleCloudStorage } from "./gcs";
import { runMigrations } from "./migrations";

function log(message: string) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

const app = express();

// Cloud Run kjører bak Google Frontend som setter X-Forwarded-For. Trust den
// éne proxien så req.ip blir ekte klient-IP (kritisk for rate-limit-keying).
app.set("trust proxy", 1);

// Rate-limit på signed-URL-utstedelse. Hindrer at én bruker (IP) drukner
// upload-pipelinen og forhindrer fakturasjokk via abuse. Tall er liberale —
// en ekte event-bruker laster opp 50-200 bilder over 5-30 min, godt under taket.
const uploadUrlLimiter = rateLimit({
  windowMs: 60_000, // 1 min
  limit: parseInt(process.env.UPLOAD_URL_RATE_LIMIT_PER_MIN || "200", 10),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { detail: "Too many upload requests, slow down and retry shortly" },
  // Default keyGenerator bruker req.ip — fungerer korrekt med 'trust proxy' satt.
});

// Bredere DDoS-vern på alle ruter — tillater normal navigasjon men dreper flood.
const globalLimiter = rateLimit({
  windowMs: 60_000,
  limit: parseInt(process.env.GLOBAL_RATE_LIMIT_PER_MIN || "1000", 10),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { detail: "Rate limit exceeded" },
});

// CORS — eksplisitt allowlist via env-var (komma-separert)
// Eksempel: CORS_ORIGINS="https://event.evenero.com,https://evenero-app-staging.vercel.app"
const corsOrigins = (process.env.CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true); // Server-to-server, curl, etc.
      if (corsOrigins.length === 0) {
        log(`[CORS] WARNING: CORS_ORIGINS is empty, allowing ${origin}`);
        return callback(null, true);
      }
      if (corsOrigins.includes(origin)) return callback(null, true);
      log(`[CORS] Rejected origin: ${origin}`);
      return callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: true,
  })
);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: false, limit: "10mb" }));

// Request logging — kun /api-paths
app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }
      if (logLine.length > 200) {
        logLine = logLine.slice(0, 199) + "…";
      }
      log(logLine);
    }
  });

  next();
});

(async () => {
  initGoogleCloudStorage();
  await runMigrations();

  // Rate-limiters MÅ registreres før routes (de er middleware som matcher etter path).
  app.use(
    [
      "/generate-signed-url",
      "/api/generate-signed-url",
      "/generate-signed-urls",
      "/api/generate-signed-urls",
    ],
    uploadUrlLimiter,
  );
  app.use("/api", globalLimiter);

  const server = await registerRoutes(app);

  // Error handler MÅ være etter routes
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err.type === "entity.too.large" || err.status === 413 || err.statusCode === 413) {
      return res.status(413).json({ message: "Filen er for stor. Prøv et mindre bilde (maks 10 MB)." });
    }
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";
    log(`[ERROR ${status}] ${message}`);
    res.status(status).json({ message });
  });

  const port = parseInt(process.env.PORT || "8080", 10);
  server.listen({ port, host: "0.0.0.0" }, () => {
    log(`main-api listening on port ${port}`);
  });

  // Reminder scheduler — kjører kun hvis env-var er satt eksplisitt.
  // På Cloud Run med scale-to-zero vil dette være upålitelig — bør migreres til Cloud Scheduler.
  // Inntil videre: sett ENABLE_REMINDER_SCHEDULER=true + --min-instances=1 i Cloud Run-deploy.
  if (process.env.ENABLE_REMINDER_SCHEDULER === "true") {
    setInterval(async () => {
      try {
        const response = await fetch(`http://localhost:${port}/api/process-reminders`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        if (response.ok) {
          const result = (await response.json()) as { sent?: number; failed?: number };
          if ((result.sent ?? 0) > 0) {
            log(`[REMINDER SCHEDULER] Sent ${result.sent} reminder(s), failed: ${result.failed ?? 0}`);
          }
        }
      } catch {
        // Silently fail
      }
    }, 60_000);
    log("[REMINDER SCHEDULER] Started (every 60 seconds)");
  } else {
    log("[REMINDER SCHEDULER] Disabled — set ENABLE_REMINDER_SCHEDULER=true to enable");
  }
})();
