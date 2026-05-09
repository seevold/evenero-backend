import express from 'express';
import { config } from './config.js';
import { processImage } from './processor.js';
import { downloadObject, parseInputPath, uploadVariants, variantsAlreadyExist } from './gcs.js';

const app = express();
// Pub/Sub push-meldinger er JSON, små (envelope + base64 GCS event).
app.use(express.json({ limit: '1mb' }));

// Pub/Sub push envelope: https://cloud.google.com/pubsub/docs/push#receive_push
type PubSubPushBody = {
  message?: {
    data?: string; // base64-encoded GCS event JSON
    attributes?: Record<string, string>;
    messageId?: string;
    publishTime?: string;
  };
  subscription?: string;
};

// GCS finalize event payload.
type GcsEvent = {
  bucket: string;
  name: string;
  contentType?: string;
  size?: string;
  metageneration?: string;
};

function parsePubSubMessage(body: PubSubPushBody): GcsEvent | null {
  const data = body?.message?.data;
  if (!data) return null;
  try {
    const decoded = Buffer.from(data, 'base64').toString('utf8');
    return JSON.parse(decoded) as GcsEvent;
  } catch {
    return null;
  }
}

app.get('/healthz', (_req, res) => {
  res.status(200).send('ok');
});

// Pub/Sub push endpoint. Returnerer:
//   200/204  → ack (Pub/Sub fjerner meldingen)
//   non-2xx  → nack (Pub/Sub retry m/ exponential backoff, til DLQ etter N forsøk)
app.post('/', async (req, res) => {
  const event = parsePubSubMessage(req.body as PubSubPushBody);
  if (!event) {
    console.warn('Bad push envelope, acking to avoid retry loop');
    return res.status(204).end();
  }

  if (event.bucket !== config.bucket) {
    console.log(`Skip: wrong bucket ${event.bucket}`);
    return res.status(204).end();
  }

  const parsed = parseInputPath(event.name);
  if (!parsed) {
    console.log(`Skip: ${event.name} ikke i ${config.inputPrefix}/{eventId}/{mediaId}.{ext}`);
    return res.status(204).end();
  }

  const { eventId, mediaId, ext } = parsed;

  // Skip non-images. Eventarc filterer ideelt sett på contentType, men dobbeltsjekker.
  if (event.contentType && !event.contentType.startsWith('image/')) {
    console.log(`Skip: ${event.name} contentType=${event.contentType}`);
    return res.status(204).end();
  }

  try {
    if (await variantsAlreadyExist(eventId, mediaId)) {
      console.log(`Skip: derived/${eventId}/${mediaId}/ finnes fra før (idempotent)`);
      return res.status(204).end();
    }

    const t0 = Date.now();
    const buf = await downloadObject(event.name);
    const downloadMs = Date.now() - t0;

    const result = await processImage(buf);

    const t2 = Date.now();
    await uploadVariants(eventId, mediaId, result.variants);
    const uploadMs = Date.now() - t2;

    console.log(
      JSON.stringify({
        msg: 'processed',
        eventId,
        mediaId,
        ext,
        sourceFormat: result.sourceFormat,
        sourceBytes: result.sourceBytes,
        width: result.width,
        height: result.height,
        thumbBytes: result.variants.find((v) => v.name === 'thumb')?.bytes,
        mediumBytes: result.variants.find((v) => v.name === 'medium')?.bytes,
        downloadMs,
        processMs: result.durationMs,
        uploadMs,
        totalMs: Date.now() - t0,
      }),
    );

    return res.status(204).end();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // GCS 404: objektet er slettet før vi rakk å prosessere. Ack stille — ingen
    // grunn til retry. Skjer for test-data og for filer brukeren angrer på upload av.
    const code = (err as { code?: number })?.code;
    if (code === 404 || /No such object/.test(message)) {
      console.log(JSON.stringify({ msg: 'skip-not-found', eventId, mediaId, objectName: event.name }));
      return res.status(204).end();
    }
    console.error(
      JSON.stringify({
        msg: 'failed',
        eventId,
        mediaId,
        objectName: event.name,
        error: message,
      }),
    );
    // 500 → Pub/Sub retry. Korrupte input havner i DLQ etter maxDeliveryAttempts.
    return res.status(500).json({ error: message });
  }
});

const server = app.listen(config.port, () => {
  console.log(
    JSON.stringify({
      msg: 'started',
      port: config.port,
      bucket: config.bucket,
      inputPrefix: config.inputPrefix,
      outputPrefix: config.outputPrefix,
    }),
  );
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server');
  server.close(() => process.exit(0));
});
