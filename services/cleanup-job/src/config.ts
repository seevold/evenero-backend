// Env-config for cleanup-job. Fail-fast pattern (samme som zipper-service-v2):
// Required env-vars throw'er ved oppstart hvis ikke satt — bedre å feile høyt
// enn å silent kjøre mot feil miljø.

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function optionalNum(name: string, defaultValue: number): number {
  const v = process.env[name];
  if (!v) return defaultValue;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new Error(`Env var ${name}='${v}' is not a valid number`);
  }
  return n;
}

function optionalBool(name: string, defaultValue: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return defaultValue;
  return v.toLowerCase() === "true" || v === "1";
}

export const config = {
  // GCS bucket — staging eller prod. Ingen fallback.
  gcsBucket: required("GCS_BUCKET_NAME"),

  // DB-tilkobling — samme mønster som main-api
  cloudSqlInstance: process.env.CLOUD_SQL_INSTANCE,
  dbName: process.env.DB_NAME || "postgres",
  dbUser: process.env.DB_USER,
  dbPassword: process.env.DB_PASSWORD,
  dbIamAuth: optionalBool("DB_IAM_AUTH", false),
  databaseUrl: process.env.DATABASE_URL,
  dbSsl: optionalBool("DB_SSL", false),

  // ==== SAFETY-RAILS ====

  // Default true — kjør aldri en deletion uten å eksplisitt sette CLEANUP_DRY_RUN=false.
  // Dette beskytter mot at en feilkonfigurert kjøring tømmer bucket-en.
  dryRun: optionalBool("CLEANUP_DRY_RUN", true),

  // Grace-periode: hvor mange dager etter archive/reject/event-delete før
  // cron sletter. 30 dager matcher cleanup-planens karantene-prinsipp.
  graceDays: optionalNum("CLEANUP_GRACE_DAYS", 30),

  // Caps per kjøring. Halt hvis overskredet — beskytter mot at en uventet
  // tilstand (massive backlog, ny path-pattern, klassifiserings-bug) tømmer
  // bucket-en i én go.
  maxFilesPerRun: optionalNum("CLEANUP_MAX_FILES_PER_RUN", 1000),
  maxBytesPerRun: optionalNum("CLEANUP_MAX_BYTES_PER_RUN", 10 * 1024 * 1024 * 1024), // 10 GB

  // Halt-on-anomaly: hvis denne kjøringen treffer mer enn ANOMALY_MULTIPLIER × forrige run, abort.
  // Brukes kun hvis cleanup_run-tabellen har historie å sammenligne mot.
  anomalyMultiplier: optionalNum("CLEANUP_ANOMALY_MULTIPLIER", 5),

  // ==== ORPHAN-SCAN ====
  // Bucket-scan er dyrere (lister alle objekter) og potensielt farligere
  // (kan slette ved feil-klassifisering). Default: skru på eksplisitt.
  scanOrphans: optionalBool("CLEANUP_SCAN_ORPHANS", false),

  // Orphan-grace: en GCS-fil må være eldre enn dette FØR den vurderes som orphan.
  // Beskytter mot race-conditions: en upload som nettopp har lagt en fil i bucket
  // men ikke rakket å skrive event_images-raden ennå.
  orphanGraceDays: optionalNum("CLEANUP_ORPHAN_GRACE_DAYS", 7),

  // ==== ALERTING (via Mailgun, samme som main-api) ====
  alertEmail: process.env.ALERT_EMAIL, // ingen alert hvis ikke satt
  mailgunApiKey: process.env.MAILGUN_API_KEY || "",
  mailgunDomain: process.env.MAILGUN_DOMAIN || "www.evenero.com",
  mailgunApiBase: process.env.MAILGUN_API_BASE || "https://api.eu.mailgun.net/v3",
  mailgunFrom: process.env.MAILGUN_FROM || `noreply@${process.env.MAILGUN_DOMAIN || "www.evenero.com"}`,
  mailgunFromName: process.env.MAILGUN_FROM_NAME || "Evenero",
};
