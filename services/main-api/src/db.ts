import { Pool, type PoolConfig } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { Connector, IpAddressTypes, AuthTypes } from "@google-cloud/cloud-sql-connector";
import * as schema from "@shared/schema";

if (!process.env.DATABASE_URL && !process.env.CLOUD_SQL_INSTANCE) {
  throw new Error(
    "Database not configured. Set either DATABASE_URL (lokal/direkte) eller CLOUD_SQL_INSTANCE (Cloud Run via connector).",
  );
}

async function buildPool(): Promise<Pool> {
  if (process.env.CLOUD_SQL_INSTANCE) {
    // Cloud Run-path: Cloud SQL Connector. To moduser:
    //   DB_IAM_AUTH=true  → IAM-auth via Cloud Run SA, ingen passord
    //   ellers             → built-in user med DB_USER/DB_PASSWORD
    const useIam = process.env.DB_IAM_AUTH === "true";
    const connector = new Connector();
    const clientOpts = await connector.getOptions({
      instanceConnectionName: process.env.CLOUD_SQL_INSTANCE,
      ipType: IpAddressTypes.PUBLIC,
      ...(useIam ? { authType: AuthTypes.IAM } : {}),
    });

    const config: PoolConfig = {
      ...clientOpts,
      user: process.env.DB_USER || (useIam ? undefined : "postgres"),
      ...(useIam ? {} : { password: process.env.DB_PASSWORD }),
      database: process.env.DB_NAME || "postgres",
      // Connection-budsjett: max × Cloud Run maxScale må holde seg under DB-ens
      // max_connections (200). 6×25 (main-api) + 5×10 (web-api) + 5 (cleanup-job)
      // = 205 teoretisk maks — overskytende fast-failer rent i stedet for å OOM-e
      // databasen. Spørringene er indekserte (ms), så 6 conns metter ikke ved
      // conc 80 — kø-ventetid er målt/beregnet til <1s selv ved full instans.
      max: 6,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
      idleTimeoutMillis: 60000,
      // Fast-fail når DB-en er mettet i stedet for å henge til Cloud Run-timeouten
      // (300s) — et hengende kall pinner instansen og forsterker connection-stormen.
      connectionTimeoutMillis: 5000,
    };

    console.log(`[DB] Connected via Cloud SQL Connector to ${process.env.CLOUD_SQL_INSTANCE} (auth=${useIam ? "IAM" : "password"}, user=${config.user})`);
    return new Pool(config);
  }

  // Lokal dev-path: standard DATABASE_URL
  const dbUrl = process.env.DATABASE_URL!;
  const urlParts = dbUrl.match(/^(postgresql:\/\/)([^:]+):([^@]+)@(.+)$/);
  let connectionString = dbUrl;
  if (urlParts) {
    const [, protocol, username, password, rest] = urlParts;
    connectionString = `${protocol}${username}:${encodeURIComponent(password)}@${rest}`;
  }

  console.log("[DB] Connected via DATABASE_URL");
  return new Pool({
    connectionString,
    ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
    idleTimeoutMillis: 60000,
    connectionTimeoutMillis: 5000,
  });
}

export const pool = await buildPool();
// Uten denne listener vil idle-connection-feil (f.eks. Cloud SQL/GFE som lukker en
// idle TLS-socket) bli unhandled og krashe Node-prosessen — pg fjerner den dårlige
// clienten fra poolen automatisk uansett.
pool.on("error", (err) => {
  console.error("[DB] idle client error (removed from pool)", err);
});
export const db = drizzle(pool, { schema });
