function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  bucket: required('GCS_BUCKET_NAME'),
  projectId: required('GCP_PROJECT_ID'),

  // Cloud Tasks
  queueLocation: process.env.QUEUE_LOCATION || 'europe-west1',
  queueName: process.env.QUEUE_NAME || 'zip-queue-v2-staging',

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

  // ZIP-ytelse: archiver buffer + read chunk size. Identisk med v1.
  archiverHighWaterMark: parseInt(process.env.ARCHIVER_HIGH_WATER_MARK || String(512 * 1024), 10),
  readStreamHighWaterMark: parseInt(process.env.READ_STREAM_HIGH_WATER_MARK || String(256 * 1024), 10),
  filePerStreamTimeoutMs: parseInt(process.env.FILE_TIMEOUT_MS || '60000', 10),

  port: parseInt(process.env.PORT || '8080', 10),
};
