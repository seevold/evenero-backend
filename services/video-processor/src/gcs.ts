import { Storage } from '@google-cloud/storage';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { config } from './config.js';

const storage = new Storage();
const bucket = storage.bucket(config.bucket);

export async function downloadObjectToFile(objectName: string, destPath: string): Promise<void> {
  const readStream = bucket.file(objectName).createReadStream();
  const writeStream = createWriteStream(destPath);
  await pipeline(readStream, writeStream);
}

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

export function previewOutputPath(eventId: string, mediaId: string): string {
  return `${config.outputPrefix}/${eventId}/${mediaId}/preview.mp4`;
}

export function posterOutputPath(eventId: string, mediaId: string): string {
  return `${config.outputPrefix}/${eventId}/${mediaId}/poster.jpg`;
}

export async function uploadFile(
  localPath: string,
  destObject: string,
  contentType: string,
): Promise<void> {
  await bucket.upload(localPath, {
    destination: destObject,
    contentType,
    resumable: false,
    metadata: {
      cacheControl: 'public, max-age=31536000, immutable',
    },
  });
}

export async function previewAlreadyExists(eventId: string, mediaId: string): Promise<boolean> {
  const [exists] = await bucket.file(previewOutputPath(eventId, mediaId)).exists();
  return exists;
}
