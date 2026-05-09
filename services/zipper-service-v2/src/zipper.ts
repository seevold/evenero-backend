import { Storage, type File } from '@google-cloud/storage';
import archiver from 'archiver';
import crypto from 'node:crypto';
import { config } from './config.js';

const storage = new Storage();
const bucket = storage.bucket(config.bucket);

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
    const file = bucket.file(path);
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
  const zipFile = bucket.file(zipObjectName);

  const writeStream = zipFile.createWriteStream({
    metadata: {
      contentType: 'application/zip',
      metadata: {
        eventId,
        eventName: cleanName(eventName),
        jobId,
        createdAt: new Date().toISOString(),
      },
    },
    resumable: false,
  });

  const archive = archiver('zip', {
    zlib: { level: 0 }, // Store-only — JPEG/MP4 er allerede komprimert.
    highWaterMark: config.archiverHighWaterMark,
  });

  archive.on('warning', (err) => console.warn('Archive warning:', err.message));

  // Pipe — feil håndteres på finale-promise.
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

  // Finalize archive, så vent til GCS-upload er ferdig.
  await archive.finalize();
  await new Promise<void>((resolve, reject) => {
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
  });

  const [metadata] = await zipFile.getMetadata();
  const sizeBytes = parseInt(String(metadata.size ?? '0'), 10);

  const [signedUrl] = await zipFile.getSignedUrl({
    version: 'v4',
    action: 'read',
    expires: Date.now() + config.signedUrlExpiryDays * 24 * 60 * 60 * 1000,
  });

  return {
    zipPath: zipObjectName,
    signedUrl,
    sizeBytes,
    fileCount: processed,
    skipped,
    errors,
    processingTimeMs: Date.now() - started,
  };
}
