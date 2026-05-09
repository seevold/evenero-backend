import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config } from './config.js';
import { processVideo } from './processor.js';
import {
  downloadObjectToFile,
  parseInputPath,
  previewAlreadyExists,
  previewOutputPath,
  posterOutputPath,
  uploadFile,
} from './gcs.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

type PubSubPushBody = {
  message?: {
    data?: string;
    attributes?: Record<string, string>;
    messageId?: string;
    publishTime?: string;
  };
  subscription?: string;
};

type GcsEvent = {
  bucket: string;
  name: string;
  contentType?: string;
  size?: string;
};

function parsePubSubMessage(body: PubSubPushBody): GcsEvent | null {
  const data = body?.message?.data;
  if (!data) return null;
  try {
    return JSON.parse(Buffer.from(data, 'base64').toString('utf8')) as GcsEvent;
  } catch {
    return null;
  }
}

app.get('/healthz', (_req, res) => {
  res.status(200).send('ok');
});

app.post('/', async (req, res) => {
  const event = parsePubSubMessage(req.body as PubSubPushBody);
  if (!event) {
    console.warn('Bad push envelope, acking');
    return res.status(204).end();
  }

  if (event.bucket !== config.bucket) {
    return res.status(204).end();
  }

  const parsed = parseInputPath(event.name);
  if (!parsed) {
    console.log(`Skip: ${event.name} ikke i ${config.inputPrefix}/{eventId}/{mediaId}.{ext}`);
    return res.status(204).end();
  }

  if (event.contentType && !event.contentType.startsWith('video/')) {
    // Stille skip — image-processor lytter på samme topic.
    return res.status(204).end();
  }

  const sourceBytes = parseInt(event.size ?? '0', 10);
  if (sourceBytes > 0 && sourceBytes > config.maxInputBytes) {
    console.error(
      JSON.stringify({
        msg: 'too-large',
        objectName: event.name,
        sourceBytes,
        maxBytes: config.maxInputBytes,
      }),
    );
    // Ack — ingen retry på en fil som er for stor.
    return res.status(204).end();
  }

  const { eventId, mediaId, ext } = parsed;
  const tempDir = await mkdtemp(join(tmpdir(), 'vid-'));
  const inputPath = join(tempDir, `in.${ext}`);
  const previewPath = join(tempDir, 'preview.mp4');
  const posterPath = join(tempDir, 'poster.jpg');

  try {
    if (await previewAlreadyExists(eventId, mediaId)) {
      console.log(`Skip: derived/${eventId}/${mediaId}/preview.mp4 finnes fra før (idempotent)`);
      return res.status(204).end();
    }

    const t0 = Date.now();
    await downloadObjectToFile(event.name, inputPath);
    const downloadMs = Date.now() - t0;

    const result = await processVideo(inputPath, previewPath, posterPath);

    const t2 = Date.now();
    await Promise.all([
      uploadFile(previewPath, previewOutputPath(eventId, mediaId), 'video/mp4'),
      uploadFile(posterPath, posterOutputPath(eventId, mediaId), 'image/jpeg'),
    ]);
    const uploadMs = Date.now() - t2;

    console.log(
      JSON.stringify({
        msg: 'processed',
        eventId,
        mediaId,
        ext,
        strategy: result.strategy,
        sourceBytes,
        durationSec: result.probe.durationSec,
        sourceWidth: result.probe.width,
        sourceHeight: result.probe.height,
        sourceCodec: result.probe.videoCodec,
        sourceBitrate: result.probe.bitrate,
        previewBytes: result.previewBytes,
        posterBytes: result.posterBytes,
        downloadMs,
        encodeMs: result.encodeMs,
        posterMs: result.posterMs,
        uploadMs,
        totalMs: Date.now() - t0,
      }),
    );

    return res.status(204).end();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // GCS 404: objektet er slettet før vi rakk å prosessere. Ack stille — ingen retry.
    const code = (err as { code?: number })?.code;
    if (code === 404 || /No such object/.test(message)) {
      console.log(JSON.stringify({ msg: 'skip-not-found', eventId, mediaId, objectName: event.name }));
      return res.status(204).end();
    }
    console.error(
      JSON.stringify({ msg: 'failed', eventId, mediaId, objectName: event.name, error: message }),
    );
    return res.status(500).json({ error: message });
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
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
