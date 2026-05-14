// GCS-implementering av OutputBackend (eksisterende default-flyt).
// Trekt ut fra original zipper.ts uten logikk-endringer.

import { Storage } from '@google-cloud/storage';
import type { Writable } from 'node:stream';
import type { OutputBackend, ZipUploadHandle } from './interface.js';

export class GcsBackend implements OutputBackend {
  readonly kind = 'gcs' as const;
  private readonly storage = new Storage();

  constructor(private readonly bucketName: string) {}

  createUpload(objectName: string, contentType: string): ZipUploadHandle {
    const file = this.storage.bucket(this.bucketName).file(objectName);
    const stream: Writable = file.createWriteStream({
      metadata: {
        contentType,
      },
      resumable: false,
    });
    const completion = new Promise<void>((resolve, reject) => {
      stream.on('finish', () => resolve());
      stream.on('error', reject);
    });
    return { stream, completion };
  }

  async getObjectSize(objectName: string): Promise<number> {
    const [metadata] = await this.storage.bucket(this.bucketName).file(objectName).getMetadata();
    return parseInt(String(metadata.size ?? '0'), 10);
  }

  async getSignedUrl(objectName: string, expiryDays: number): Promise<string> {
    const [signedUrl] = await this.storage.bucket(this.bucketName).file(objectName).getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + expiryDays * 24 * 60 * 60 * 1000,
    });
    return signedUrl;
  }
}
