// Cloud Run Job entrypoint for zipper.
//
// Kontainer kjører i Job-mode når JOB_MODE=true (satt i Job-deployen).
// Denne fila leser payload fra GCS (skrevet av /zip-handleren), kjører
// buildZip, og sender webhook ved fullført eller feilet jobb.
//
// Cloud Run Jobs gir ingen request-deadline — vi har 24t per task-execution
// og 12t timeout på vår config. Det betyr ZIPs på 100+ GB kan fullføres uten
// kunstig avbryting (kontrast til Cloud Tasks 30-min limit).
//
// Payload leveres via GCS (ikke env-var) fordi Cloud Run Jobs har 32 KB-limit
// per env-var, og store events kan ha mediaIds-lister på 1+ MB.

import { Storage } from '@google-cloud/storage';
import { config } from './config.js';
import { buildZip, type ZipResult } from './zipper.js';
import { sendWebhook } from './webhook.js';

const storage = new Storage();

type JobPayload = {
  jobId: string;
  mediaIds: string[];
  eventName: string;
  eventId: string;
  userEmail: string;
  zipFileName: string;
};

async function readPayload(payloadObj: string): Promise<JobPayload> {
  const [data] = await storage.bucket(config.bucket).file(payloadObj).download();
  return JSON.parse(data.toString()) as JobPayload;
}

async function deletePayload(payloadObj: string): Promise<void> {
  // Best-effort cleanup. Hvis sletting feiler ryddes av lifecycle (1-dag TTL).
  try {
    await storage.bucket(config.bucket).file(payloadObj).delete();
  } catch {
    /* ignore */
  }
}

async function main(): Promise<void> {
  const payloadObj = process.env.JOB_PAYLOAD_OBJECT;
  if (!payloadObj) {
    console.error(JSON.stringify({ msg: 'no-payload-env' }));
    process.exit(1);
  }

  let payload: JobPayload;
  try {
    payload = await readPayload(payloadObj);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ msg: 'payload-read-failed', payloadObj, error: message }));
    process.exit(1);
  }

  const { jobId, mediaIds, eventName, eventId, userEmail, zipFileName } = payload;
  console.log(
    JSON.stringify({
      msg: 'job-start',
      jobId,
      eventId,
      fileCount: mediaIds.length,
      userEmail,
      zipFileName,
    }),
  );

  let result: ZipResult;
  try {
    result = await buildZip(jobId, mediaIds, eventId, eventName, zipFileName);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ msg: 'job-failed', jobId, eventId, error: message }));
    await sendWebhook('zip.failed', {
      jobId,
      eventId,
      eventName,
      userEmail,
      error: message,
    }).catch((e) => console.warn('webhook fail:', e));
    await deletePayload(payloadObj);
    process.exit(1);
  }

  console.log(
    JSON.stringify({
      msg: 'job-completed',
      jobId,
      eventId,
      sizeMB: Math.round((result.sizeBytes / 1024 / 1024) * 10) / 10,
      fileCount: result.fileCount,
      skipped: result.skipped,
      processingTimeMs: result.processingTimeMs,
    }),
  );

  await sendWebhook('zip.completed', {
    jobId,
    eventId,
    eventName,
    userEmail,
    status: 'completed',
    zipUrl: result.signedUrl,
    zipPath: result.zipPath,
    zipFileName,
    fileCount: result.fileCount,
    skippedCount: result.skipped,
    sizeMB: Math.round((result.sizeBytes / 1024 / 1024) * 10) / 10,
    processingTimeSeconds: Math.round(result.processingTimeMs / 1000),
    outputBackend: result.outputBackend,
    errors: result.errors.length > 0 ? result.errors.slice(0, 10) : undefined,
  }).catch((e) => console.warn('webhook fail:', e));

  await deletePayload(payloadObj);
  process.exit(0);
}

main();
