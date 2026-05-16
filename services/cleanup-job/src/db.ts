// DB-tilkobling — gjenbruker mønsteret fra main-api.
// Bruker raw pg-pool, ingen ORM — vi har bare 3-4 queries.

import { Pool, type PoolConfig } from "pg";
import { Connector, IpAddressTypes, AuthTypes } from "@google-cloud/cloud-sql-connector";
import { config } from "./config.js";

async function buildPool(): Promise<Pool> {
  if (config.cloudSqlInstance) {
    const connector = new Connector();
    const clientOpts = await connector.getOptions({
      instanceConnectionName: config.cloudSqlInstance,
      ipType: IpAddressTypes.PUBLIC,
      ...(config.dbIamAuth ? { authType: AuthTypes.IAM } : {}),
    });

    const poolConfig: PoolConfig = {
      ...clientOpts,
      user: config.dbUser || (config.dbIamAuth ? undefined : "postgres"),
      ...(config.dbIamAuth ? {} : { password: config.dbPassword }),
      database: config.dbName,
      max: 5, // job-prosess — lite parallellitet
    };

    console.log(
      `[DB] Connected via Cloud SQL Connector to ${config.cloudSqlInstance} (auth=${config.dbIamAuth ? "IAM" : "password"}, user=${poolConfig.user})`,
    );
    return new Pool(poolConfig);
  }

  if (!config.databaseUrl) {
    throw new Error("Either CLOUD_SQL_INSTANCE or DATABASE_URL must be set");
  }

  const urlParts = config.databaseUrl.match(/^(postgresql:\/\/)([^:]+):([^@]+)@(.+)$/);
  let connectionString = config.databaseUrl;
  if (urlParts) {
    const [, protocol, username, password, rest] = urlParts;
    connectionString = `${protocol}${username}:${encodeURIComponent(password)}@${rest}`;
  }

  console.log("[DB] Connected via DATABASE_URL");
  return new Pool({
    connectionString,
    ssl: config.dbSsl ? { rejectUnauthorized: false } : false,
  });
}

export const pool = await buildPool();
