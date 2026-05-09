import express from 'express';
import { config } from './config.js';
import { processImage } from './processor.js';
import {
  downloadObject,
  parseInputPath,
  skippedFlagPath,
  uploadJson,
  uploadVariants,
  variantsAlreadyExist,
} from './gcs.js';

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

  // Helper for best-effort skip-flag (sharp-feil, korrupt input, ukjent format).
  // Frontend faller tilbake til original-fila.
  async function writeSkippedFlag(reason: string, errorMessage: string): Promise<void> {
    await uploadJson(skippedFlagPath(eventId, mediaId), {
      skipped: true,
      reason,
      error: errorMessage,
      sourceBytes: parseInt(event!.size ?? '0', 10),
      contentType: event!.contentType,
      objectName: event!.name,
      timestamp: new Date().toISOString(),
    }).catch((e) => console.warn('skipped-flag write failed:', e));
  }

  try {
    if (await variantsAlreadyExist(eventId, mediaId)) {
      console.log(`Skip: derived/${eventId}/${mediaId}/ finnes fra før (idempotent)`);
      return res.status(204).end();
    }

    const t0 = Date.now();
    let buf: Buffer;
    try {
      buf = await downloadObject(event.name);
    } catch (err) {
      const code = (err as { code?: number })?.code;
      const message = err instanceof Error ? err.message : String(err);
      if (code === 404 || /No such object/.test(message)) {
        // Original slettet før prosessering — ack uten flag.
        console.log(JSON.stringify({ msg: 'skip-not-found', eventId, mediaId, objectName: event.name }));
        return res.status(204).end();
      }
      // GCS-feil (auth, network) → reell retry-verdig feil.
      throw err;
    }
    const downloadMs = Date.now() - t0;

    let result;
    try {
      result = await processImage(buf);
    } catch (err) {
      // Sharp-feil = korrupt eller ukjent format. Aldri retry-verdig — ack med flag.
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        JSON.stringify({ msg: 'skipped-sharp-error', eventId, mediaId, objectName: event.name, error: message }),
      );
      await writeSkippedFlag('sharp-error', message);
      return res.status(204).end();
    }

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
    // Vi har allerede håndtert: GCS 404 (skip), GCS download-error (rethrow),
    // sharp-error (skip-flag). Det som lander her er upload-feil mot derived/-bucket
    // — som er en transient infrastrukturfeil og verdig retry.
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({ msg: 'failed', eventId, mediaId, objectName: event.name, error: message }),
    );
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
