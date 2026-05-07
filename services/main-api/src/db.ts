import { Pool, type PoolConfig } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { Connector, IpAddressTypes } from "@google-cloud/cloud-sql-connector";
import * as schema from "@shared/schema";

if (!process.env.DATABASE_URL && !process.env.CLOUD_SQL_INSTANCE) {
  throw new Error(
    "Database not configured. Set either DATABASE_URL (lokal/direkte) eller CLOUD_SQL_INSTANCE (Cloud Run via connector).",
  );
}

async function buildPool(): Promise<Pool> {
  if (process.env.CLOUD_SQL_INSTANCE) {
    // Cloud Run-path: bruker Cloud SQL Connector med automatisk IAM-auth.
    // CLOUD_SQL_INSTANCE format: "project:region:instance"
    //   eks.: "evenero:europe-north1:evenero-db-staging"
    const connector = new Connector();
    const clientOpts = await connector.getOptions({
      instanceConnectionName: process.env.CLOUD_SQL_INSTANCE,
      ipType: IpAddressTypes.PUBLIC,
    });

    const config: PoolConfig = {
      ...clientOpts,
      user: process.env.DB_USER || "postgres",
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME || "postgres",
      max: 10,
    };

    console.log(`[DB] Connected via Cloud SQL Connector to ${process.env.CLOUD_SQL_INSTANCE}`);
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
  });
}

export const pool = await buildPool();
export const db = drizzle(pool, { schema });
