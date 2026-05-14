import { Storage, type File } from '@google-cloud/storage';
import archiver from 'archiver';
import crypto from 'node:crypto';
import { config } from './config.js';
import { getOutputBackend } from './storage/factory.js';

// Input-bucket (originals) er ALLTID GCS — uavhengig av hvor output ZIP havner.
// Cloud Run + GCS i samme region = $0 read-egress.
const inputStorage = new Storage();
const inputBucket = inputStorage.bucket(config.bucket);

function cleanName(s: string): string {
  return s.replace(/[^a-zA-Z0-9\s_-]/g, '').replace(/\s+/g, '_').substring(0, 50).trim();
}

export function generateZipName(eventName: string, eventId: string): string {
  const cleanEvent = cleanName(eventName) || 'event';
  const date = new Date().toISOString().split('T')[0].replace(/-/g, '');
  const rand = crypto.randomBytes(3).toString('hex');
  return `${cleanEvent}_${date}_${eventId}_${rand}.zip`;
}

// Slår opp én mediaId mot v2- og v1-paths i rekkefølge. Returner første treff.
async function resolveMediaFile(
  rawId: string,
  eventId: string,
): Promise<File | null> {
  const id = String(rawId).replace(/^(images\/|\/images\/|\/)/, '');
  for (const tmpl of config.searchPathTemplates) {
    const path = tmpl.replace('{eventId}', eventId).replace('{mediaId}', id);
    const file = inputBucket.file(path);
    try {
      const [exists] = await file.exists();
      if (exists) return file;
    } catch {
      continue;
    }
  }
  return null;
}

export type ZipResult = {
  zipPath: string;
  signedUrl: string;
  sizeBytes: number;
  fileCount: number;
  skipped: number;
  errors: string[];
  processingTimeMs: number;
  outputBackend: 'gcs' | 'r2';
};

export async function buildZip(
  jobId: string,
  mediaIds: string[],
  eventId: string,
  eventName: string,
  zipFileName: string,
): Promise<ZipResult> {
  const started = Date.now();
  const zipObjectName = `${config.zipPrefix}${zipFileName}`;
  const backend = getOutputBackend();

  // Start streaming upload mot valgt backend (GCS eller R2).
  const { stream: writeStream, completion: uploadCompletion } = backend.createUpload(
    zipObjectName,
    'application/zip',
  );

  const archive = archiver('zip', {
    zlib: { level: 0 }, // Store-only — JPEG/MP4 er allerede komprimert.
    highWaterMark: config.archiverHighWaterMark,
  });

  archive.on('warning', (err) => console.warn('Archive warning:', err.message));

  // Pipe — feil håndteres på finale-promise (uploadCompletion).
  archive.pipe(writeStream);

  let processed = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (let i = 0; i < mediaIds.length; i++) {
    const rawId = mediaIds[i];
    const fileHandle = await resolveMediaFile(rawId, eventId);
    if (!fileHandle) {
      errors.push(`Not found: ${rawId}`);
      skipped++;
      continue;
    }

    try {
      const displayName = fileHandle.name.split('/').pop()!;
      // Default highWaterMark (16 KB) er greit her — sekvensiell streaming inn i
      // archiver, ikke et hoten-loop. v1 satte 256 KB men det er ikke synlig i typed API.
      const readStream = fileHandle.createReadStream();

      await new Promise<void>((resolve, reject) => {
        let ended = false;
        let errored = false;
        const timeout = setTimeout(() => {
          if (!ended && !errored) reject(new Error(`Timeout streaming ${displayName}`));
        }, config.filePerStreamTimeoutMs);

        readStream.on('end', () => {
          ended = true;
          clearTimeout(timeout);
          // Liten mikrotick så archiver får fordøye chunks.
          setImmediate(() => {
            if (!errored) resolve();
          });
        });
        readStream.on('error', (err) => {
          errored = true;
          clearTimeout(timeout);
          reject(err);
        });

        archive.append(readStream, { name: displayName });
      });

      processed++;
      // Slipp event loop hver 100. fil for GC.
      if (processed % 100 === 0) {
        await new Promise((r) => setImmediate(r));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Error ${rawId}: ${msg}`);
      skipped++;
    }
  }

  if (processed === 0) {
    archive.abort();
    writeStream.destroy();
    throw new Error('No files found to add to ZIP');
  }

  // Finalize archive — closes archiver-stream → trigger upload-finalize.
  await archive.finalize();
  // Vent på at uploaden faktisk er committed til storage (GCS finish eller
  // R2 multipart-complete).
  await uploadCompletion;

  const sizeBytes = await backend.getObjectSize(zipObjectName);
  const signedUrl = await backend.getSignedUrl(zipObjectName, config.signedUrlExpiryDays);

  return {
    zipPath: zipObjectName,
    signedUrl,
    sizeBytes,
    fileCount: processed,
    skipped,
    errors,
    processingTimeMs: Date.now() - started,
    outputBackend: backend.kind,
  };
}
