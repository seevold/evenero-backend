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

    let readStream: ReturnType<typeof fileHandle.createReadStream> | null = null;
    try {
      const displayName = fileHandle.name.split('/').pop()!;

      // Hent fil-størrelse FØR streaming. Trengs for to grunner:
      //   1. Per-fil timeout må være proporsjonal med filstørrelse — 60s er
      //      for kort for 21 GB-filer (16 min ved 22 MB/s).
      //   2. archiver med kjent størrelse kan optimalisere ZIP central-directory.
      let fileSizeBytes = 0;
      try {
        const [meta] = await fileHandle.getMetadata();
        fileSizeBytes = parseInt(String(meta.size ?? '0'), 10);
      } catch { /* fortsett uten kjent størrelse */ }

      // Dynamisk timeout: minimum 5 min, plus 1 sek per MB. For 21 GB-fil:
      // 300s + 21*1024s = 21800s = ~6 timer maks. Beskytter mot uendelig hang
      // mens den lar real-world streaming gjennomføres uavhengig av størrelse.
      const fileSizeMb = Math.ceil(fileSizeBytes / 1024 / 1024);
      const timeoutMs = Math.max(
        config.filePerStreamTimeoutMs,
        300_000 + fileSizeMb * 1000,
      );

      console.log(JSON.stringify({
        msg: 'file-start',
        idx: i + 1,
        total: mediaIds.length,
        name: displayName,
        sizeMB: Math.round(fileSizeBytes / 1024 / 1024 * 10) / 10,
        timeoutSec: Math.round(timeoutMs / 1000),
      }));

      readStream = fileHandle.createReadStream();
      const localReadStream = readStream;

      await new Promise<void>((resolve, reject) => {
        let ended = false;
        let errored = false;
        const timeout = setTimeout(() => {
          if (!ended && !errored) {
            // Destroy stream så GCS-connection lukkes og vi ikke leakker.
            try { localReadStream.destroy(new Error('timeout')); } catch { /* ignore */ }
            reject(new Error(`Timeout streaming ${displayName} (${timeoutMs}ms)`));
          }
        }, timeoutMs);

        localReadStream.on('end', () => {
          ended = true;
          clearTimeout(timeout);
          // Liten mikrotick så archiver får fordøye chunks.
          setImmediate(() => {
            if (!errored) resolve();
          });
        });
        localReadStream.on('error', (err) => {
          errored = true;
          clearTimeout(timeout);
          reject(err);
        });

        archive.append(localReadStream, { name: displayName });
      });

      processed++;
      console.log(JSON.stringify({
        msg: 'file-done',
        idx: i + 1,
        total: mediaIds.length,
        name: displayName,
        processedSoFar: processed,
      }));

      // Slipp event loop hver 100. fil for GC.
      if (processed % 100 === 0) {
        await new Promise((r) => setImmediate(r));
      }
    } catch (err) {
      // Defensiv cleanup — hvis vi havnet her med en åpen stream, destroy den.
      if (readStream && !readStream.destroyed) {
        try { readStream.destroy(); } catch { /* ignore */ }
      }
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Error ${rawId}: ${msg}`);
      skipped++;
      console.warn(JSON.stringify({
        msg: 'file-error',
        idx: i + 1,
        rawId,
        error: msg,
      }));
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
