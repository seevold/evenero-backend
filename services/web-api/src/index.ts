import express, { type Request, Response, NextFunction } from "express";
import cors from "cors";
import { registerRoutes } from "./routes";

function log(message: string) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

const app = express();

// CORS
const corsOrigins = (process.env.CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (corsOrigins.length === 0) {
        log(`[CORS] WARNING: CORS_ORIGINS empty, allowing ${origin}`);
        return callback(null, true);
      }
      if (corsOrigins.includes(origin)) return callback(null, true);
      log(`[CORS] Rejected: ${origin}`);
      return callback(new Error(`Origin ${origin} not allowed`));
    },
    credentials: true,
  })
);

// Stripe webhook needs raw body BEFORE JSON parsing
app.use("/api/webhooks/stripe", express.raw({ type: "application/json" }));

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let captured: Record<string, any> | undefined;
  const orig = res.json;
  res.json = function (bodyJson, ...args) {
    captured = bodyJson;
    return orig.apply(res, [bodyJson, ...args]);
  };
  res.on("finish", () => {
    if (path.startsWith("/api")) {
      const duration = Date.now() - start;
      let line = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (captured) line += ` :: ${JSON.stringify(captured).slice(0, 100)}`;
      if (line.length > 200) line = line.slice(0, 199) + "…";
      log(line);
    }
  });
  next();
});

(async () => {
  const server = await registerRoutes(app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";
    log(`[ERROR ${status}] ${message}`);
    res.status(status).json({ message });
  });

  const port = parseInt(process.env.PORT || "8080", 10);
  server.listen({ port, host: "0.0.0.0" }, () => {
    log(`web-api listening on port ${port}`);
  });
})();
