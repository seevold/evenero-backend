function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  bucket: required('GCS_BUCKET_NAME'),
  projectId: required('GCP_PROJECT_ID'),

  // Cloud Tasks. queueLocation har en safe default (begge miljø bruker
  // europe-west1, eneste EU-region som støtter Cloud Tasks). queueName er
  // miljø-spesifikk (zip-queue-v2-prod vs zip-queue-v2-staging) — fail-fast
  // så vi aldri silent skriver til feil miljø.
  queueLocation: process.env.QUEUE_LOCATION || 'europe-west1',
  queueName: required('QUEUE_NAME'),

  // Service-URL — settes etter første deploy. Cloud Tasks må vite hvor /process-zip ligger.
  serviceUrl: required('SERVICE_URL'),

  // Worker-SA som Cloud Tasks bruker for OIDC mot /process-zip.
  // Samme SA som denne tjenesten kjører som — staging-runner kan invoke seg selv.
  workerServiceAccount: required('WORKER_SERVICE_ACCOUNT'),

  // ZIP-output
  zipPrefix: process.env.ZIP_PREFIX || 'derived/zip/',
  signedUrlExpiryDays: parseInt(process.env.SIGNED_URL_EXPIRY_DAYS || '7', 10),

  // Søkestier — prøves i rekkefølge for hver mediaId. v2 først, så v1-legacy.
  // Path-templates med {eventId} og {mediaId} variabler.
  searchPathTemplates: (
    process.env.SEARCH_PATH_TEMPLATES ||
    'originals/{eventId}/{mediaId},images/{mediaId},images/{eventId}/{mediaId},{mediaId}'
  ).split(','),

  // Webhook ved fullført/feilet ZIP. Optional.
  webhookUrl: process.env.WEBHOOK_URL || '',
  // Delt secret som sendes som X-API-Key i webhook-kallet, så mottaker kan
  // validere at callbacket kommer fra oss. Optional — utelates ved tomstring.
  webhookApiKey: process.env.WEBHOOK_API_KEY || '',

  // ZIP-ytelse: archiver buffer + read chunk size. Identisk med v1.
  archiverHighWaterMark: parseInt(process.env.ARCHIVER_HIGH_WATER_MARK || String(512 * 1024), 10),
  readStreamHighWaterMark: parseInt(process.env.READ_STREAM_HIGH_WATER_MARK || String(256 * 1024), 10),
  filePerStreamTimeoutMs: parseInt(process.env.FILE_TIMEOUT_MS || '60000', 10),

  port: parseInt(process.env.PORT || '8080', 10),

  // ===== Cloud Run Jobs (ny path for store ZIPs) =====
  //
  // ZIP_BACKEND velger flyten:
  //   'tasks' (default): /zip → Cloud Tasks → /process-zip (samme container, hard
  //                      30-min Cloud Tasks-deadline)
  //   'jobs'           : /zip → Cloud Tasks → /start-job → runJob() (egen Cloud Run Job
  //                      execution, opp til 12t per task)
  //
  // Vi beholder Cloud Tasks i Jobs-modus FORDI det fungerer som throttling-lag:
  // /start-job sjekker antall aktive Job-executions og returnerer 503 hvis over
  // grensen. Cloud Tasks retry-er da med backoff, slik at trafikk-spikes naturlig
  // venter i stedet for å overbelaste systemet.
  zipBackend: (process.env.ZIP_BACKEND === 'jobs' ? 'jobs' : 'tasks') as 'jobs' | 'tasks',

  // Job-config — kun nødvendig når ZIP_BACKEND=jobs.
  // jobName er miljø-spesifikk (zipper-job vs zipper-job-staging).
  jobName: process.env.JOB_NAME || '',
  jobLocation: process.env.JOB_LOCATION || 'europe-north1',

  // Concurrency-grense for samtidige Cloud Run Job-executions.
  // /start-job sjekker eksisterende Job-executions og returnerer 503 hvis over
  // denne grensen → Cloud Tasks retry-er. Naturlig back-pressure.
  // 10 er en konservativ default — kan justeres opp ved behov.
  maxConcurrentJobExecutions: parseInt(process.env.MAX_CONCURRENT_JOB_EXECUTIONS || '10', 10),

  // Hvor lenge en Job-execution maksimalt får kjøre før Cloud Run avslutter den.
  // Sett i Job-config (--task-timeout); duplikat her for log/diagnostikk-synlighet.
  jobTaskTimeoutSec: parseInt(process.env.JOB_TASK_TIMEOUT_SEC || '43200', 10),

  // ===== Output-storage backend (Cloudflare R2 vs GCS) =====
  //
  // ZIP_OUTPUT velger hvor ferdige ZIP-filer havner + hvor signed URL peker.
  //   'gcs' (default): skriv til GCS bucket (samme som i dag, $0.12/GB egress)
  //   'r2'          : skriv til Cloudflare R2 ($0 egress når kunde laster ned)
  //
  // Migrering: deploy med default 'gcs' → flip til 'r2' via env-var update på
  // både Service og Job. Rollback = sett tilbake til 'gcs'.
  zipOutput: (process.env.ZIP_OUTPUT === 'r2' ? 'r2' : 'gcs') as 'r2' | 'gcs',

  // R2-credentials. Kun nødvendig når ZIP_OUTPUT=r2.
  // accountId er en del av R2-endpoint-URLen (`https://{accountId}.r2.cloudflarestorage.com`).
  // accessKeyId + secretAccessKey kommer fra R2 API token.
  // bucket = navn på R2-bucket (f.eks. 'evenero-zips-prod').
  r2: {
    accountId: process.env.R2_ACCOUNT_ID || '',
    accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
    bucket: process.env.R2_BUCKET || '',
  },
};
