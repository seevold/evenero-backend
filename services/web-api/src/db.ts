// Web-api bruker samme Cloud SQL staging-instans som main-api.
// Refresh-koden brukte tidligere Neon — det er droppet for å konsolidere på én DB.
// Tabeller: payments, support_requests (definert i shared/schema.ts).

import { Pool, type PoolConfig } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { Connector, IpAddressTypes, AuthTypes } from "@google-cloud/cloud-sql-connector";
import * as schema from "@shared/schema";

if (!process.env.DATABASE_URL && !process.env.CLOUD_SQL_INSTANCE) {
  throw new Error("Database not configured. Set DATABASE_URL or CLOUD_SQL_INSTANCE.");
}

async function buildPool(): Promise<Pool> {
  if (process.env.CLOUD_SQL_INSTANCE) {
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
      max: 5,
    };
    console.log(`[DB] web-api connected via Cloud SQL Connector to ${process.env.CLOUD_SQL_INSTANCE} (auth=${useIam ? "IAM" : "password"}, user=${config.user})`);
    return new Pool(config);
  }

  const dbUrl = process.env.DATABASE_URL!;
  console.log("[DB] web-api connected via DATABASE_URL");
  return new Pool({
    connectionString: dbUrl,
    ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
  });
}

export const pool = await buildPool();
export const db = drizzle(pool, { schema });
