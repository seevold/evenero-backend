// Cloudflare R2-implementering av OutputBackend.
//
// R2 eksponerer en S3-kompatibel API, så vi bruker AWS SDK v3. Multi-part
// upload via @aws-sdk/lib-storage håndterer streamende ZIP-output (5 MB-5 GB
// per part, max 10000 parts → max 50 TB per objekt med 5 GB-parts; vi setter
// 32 MB parts → max 320 GB per objekt, mer enn nok for våre bruksmønstre).
//
// Endpoint-format: https://{accountId}.r2.cloudflarestorage.com
// Region: 'auto' (R2 har ingen regioner i tradisjonell forstand)
//
// Egress R2 → kunde: $0 (Cloudflare-policy). Storage: $0.015/GB/mnd.

import {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PassThrough } from 'node:stream';
import type { Writable } from 'node:stream';
import type { OutputBackend, ZipUploadHandle } from './interface.js';

export interface R2BackendConfig {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

const PART_SIZE_BYTES = 32 * 1024 * 1024; // 32 MB per multipart-del
const QUEUE_SIZE = 4; // 4 deler in-flight samtidig (~128 MB peak buffer)

export class R2Backend implements OutputBackend {
  readonly kind = 'r2' as const;
  private readonly client: S3Client;

  constructor(private readonly cfg: R2BackendConfig) {
    if (!cfg.accountId || !cfg.accessKeyId || !cfg.secretAccessKey || !cfg.bucket) {
      throw new Error('R2Backend: missing one or more required config fields');
    }
    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${cfg.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
    });
  }

  createUpload(objectName: string, contentType: string): ZipUploadHandle {
    // PassThrough som archiver pipes inn i. lib-storage Upload tar samme
    // PassThrough som Body og deler opp i multipart-parts automatisk.
    const passThrough = new PassThrough();

    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.cfg.bucket,
        Key: objectName,
        Body: passThrough,
        ContentType: contentType,
      },
      partSize: PART_SIZE_BYTES,
      queueSize: QUEUE_SIZE,
      // leavePartsOnError=false → abort multipart-upload ved error så vi ikke
      // etterlater ufullstendige uploads (R2 lifecycle cleaner dem også, men
      // best å rydde proaktivt).
      leavePartsOnError: false,
    });

    const completion = upload.done().then(() => {
      /* void result */
    });

    const stream: Writable = passThrough;
    return { stream, completion };
  }

  async getObjectSize(objectName: string): Promise<number> {
    const result = await this.client.send(
      new HeadObjectCommand({
        Bucket: this.cfg.bucket,
        Key: objectName,
      }),
    );
    return result.ContentLength ?? 0;
  }

  async getSignedUrl(objectName: string, expiryDays: number): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.cfg.bucket,
      Key: objectName,
    });
    return getSignedUrl(this.client, command, {
      expiresIn: expiryDays * 24 * 60 * 60,
    });
  }
}
