import express from 'express';
import crypto from 'node:crypto';
import { CloudTasksClient } from '@google-cloud/tasks';
import { config } from './config.js';
import { buildZip, generateZipName, type ZipResult } from './zipper.js';

const app = express();
app.use(express.json({ limit: '10mb' }));

const tasksClient = new CloudTasksClient();

type ZipRequestBody = {
  mediaIds: string[];
  eventName: string;
  eventId: string;
  userEmail: string;
};

type ProcessZipBody = ZipRequestBody & {
  jobId: string;
  zipFileName: string;
};

app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// Public-fasade: app.evenero.com (eller staging-versjon) POSTer hit. Cloud Run
// validerer OIDC automatisk via --no-allow-unauthenticated. Caller må sende
// Authorization: Bearer <id_token> med audience = denne service-URL-en.
app.post('/zip', async (req, res) => {
  const { mediaIds, eventName, eventId, userEmail } = req.body as ZipRequestBody;

  if (!Array.isArray(mediaIds) || mediaIds.length === 0) {
    return res.status(400).json({ error: 'mediaIds[] is required' });
  }
  if (!eventName || !eventId || !userEmail) {
    return res.status(400).json({ error: 'eventName, eventId, userEmail required' });
  }

  const jobId = crypto.randomBytes(16).toString('hex');
  const zipFileName = generateZipName(eventName, eventId);
  const queuePath = tasksClient.queuePath(config.projectId, config.queueLocation, config.queueName);

  try {
    const taskBody: ProcessZipBody = { jobId, mediaIds, eventName, eventId, userEmail, zipFileName };
    const [response] = await tasksClient.createTask({
      parent: queuePath,
      task: {
        httpRequest: {
          httpMethod: 'POST',
          url: `${config.serviceUrl}/process-zip`,
          headers: { 'Content-Type': 'application/json' },
          body: Buffer.from(JSON.stringify(taskBody)).toString('base64'),
          oidcToken: {
            serviceAccountEmail: config.workerServiceAccount,
            audience: config.serviceUrl,
          },
        },
      },
    });

    console.log(JSON.stringify({ msg: 'queued', jobId, taskName: response.name, fileCount: mediaIds.length }));

    return res.status(202).json({
      success: true,
      jobId,
      expectedFileName: zipFileName,
      estimatedFiles: mediaIds.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ msg: 'queue-failed', jobId, error: message }));
    return res.status(500).json({ error: 'Failed to queue ZIP job', details: message });
  }
});

// Worker-endpoint — kun callable av Cloud Tasks (med OIDC fra workerServiceAccount).
// Cloud Run validerer at audience matcher service-URL-en og signer-SA er gyldig.
app.post('/process-zip', async (req, res) => {
  const body = req.body as ProcessZipBody;
  const { jobId, mediaIds, eventName, eventId, userEmail, zipFileName } = body;

  console.log(JSON.stringify({ msg: 'start', jobId, eventId, fileCount: mediaIds.length, userEmail }));

  let result: ZipResult;
  try {
    result = await buildZip(jobId, mediaIds, eventId, eventName, zipFileName);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ msg: 'failed', jobId, eventId, error: message }));
    await sendWebhook('zip.failed', { jobId, eventId, eventName, userEmail, error: message }).catch(() => {});
    return res.status(500).json({ error: 'ZIP processing failed', details: message, jobId });
  }

  console.log(
    JSON.stringify({
      msg: 'completed',
      jobId,
      eventId,
      sizeMB: Math.round((result.sizeBytes / 1024 / 1024) * 10) / 10,
      fileCount: result.fileCount,
      skipped: result.skipped,
      processingTimeMs: result.processingTimeMs,
    }),
  );

  await sendWebhook('zip.completed', {
    jobId, eventId, eventName, userEmail,
    status: 'completed',
    zipUrl: result.signedUrl,
    zipPath: result.zipPath,
    zipFileName,
    fileCount: result.fileCount,
    skippedCount: result.skipped,
    sizeMB: Math.round((result.sizeBytes / 1024 / 1024) * 10) / 10,
    processingTimeSeconds: Math.round(result.processingTimeMs / 1000),
    errors: result.errors.length > 0 ? result.errors.slice(0, 10) : undefined,
  }).catch((e) => console.warn('webhook failed:', e));

  return res.json({
    success: true,
    jobId,
    processed: result.fileCount,
    skipped: result.skipped,
    sizeMB: Math.round((result.sizeBytes / 1024 / 1024) * 10) / 10,
    zipUrl: result.signedUrl,
    errors: result.errors.length > 0 ? result.errors.slice(0, 5) : undefined,
  });
});

async function sendWebhook(eventType: string, payload: Record<string, unknown>): Promise<void> {
  if (!config.webhookUrl) return;
  await fetch(config.webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Event-Type': eventType,
    },
    body: JSON.stringify({ ...payload, timestamp: new Date().toISOString() }),
  });
}

const server = app.listen(config.port, () => {
  console.log(JSON.stringify({
    msg: 'started',
    port: config.port,
    bucket: config.bucket,
    queue: `${config.queueLocation}/${config.queueName}`,
    serviceUrl: config.serviceUrl,
    searchPaths: config.searchPathTemplates,
  }));
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
