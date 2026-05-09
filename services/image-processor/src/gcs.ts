import { Storage } from '@google-cloud/storage';
import { config } from './config.js';
import type { Variant } from './processor.js';

const storage = new Storage();
const bucket = storage.bucket(config.bucket);

export async function downloadObject(objectName: string): Promise<Buffer> {
  const [buffer] = await bucket.file(objectName).download();
  return buffer;
}

// Parser `originals/{eventId}/{mediaId}.{ext}` → { eventId, mediaId, ext }.
// Returnerer null hvis path ikke matcher input-skjemaet (skal ignoreres).
export function parseInputPath(
  objectName: string,
): { eventId: string; mediaId: string; ext: string } | null {
  const prefix = `${config.inputPrefix}/`;
  if (!objectName.startsWith(prefix)) return null;
  const rest = objectName.slice(prefix.length);
  const m = rest.match(/^([^/]+)\/([^/]+)\.([^./]+)$/);
  if (!m) return null;
  return { eventId: m[1], mediaId: m[2], ext: m[3].toLowerCase() };
}

export function outputPath(eventId: string, mediaId: string, variant: Variant['name']): string {
  return `${config.outputPrefix}/${eventId}/${mediaId}/${variant}.webp`;
}

export async function uploadVariants(
  eventId: string,
  mediaId: string,
  variants: Variant[],
): Promise<void> {
  await Promise.all(
    variants.map(async (v) => {
      const file = bucket.file(outputPath(eventId, mediaId, v.name));
      await file.save(v.buffer, {
        contentType: v.contentType,
        resumable: false,
        metadata: {
          cacheControl: 'public, max-age=31536000, immutable',
          metadata: { eventId, mediaId, variant: v.name },
        },
      });
    }),
  );
}

// Idempotency-sjekk: hvis derived/-output finnes fra før, hopp over prosesseringen.
// Verifiserer kun thumb (raskere); medium antas tilstede hvis thumb er det.
export async function variantsAlreadyExist(eventId: string, mediaId: string): Promise<boolean> {
  const [exists] = await bucket.file(outputPath(eventId, mediaId, 'thumb')).exists();
  return exists;
}
