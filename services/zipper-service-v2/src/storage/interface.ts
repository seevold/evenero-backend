// OutputBackend abstraherer hvor ZIP-filer skrives til + signed URLs hentes fra.
//
// To implementasjoner:
//  - GcsBackend: skriver til Google Cloud Storage (eksisterende default)
//  - R2Backend:  skriver til Cloudflare R2 ($0 egress)
//
// Bare OUTPUT-siden er abstrahert. Reading av media-originals (input) skjer
// alltid mot GCS — det er der vi har data, og GCS→Cloud Run i samme region
// koster $0.

import type { Writable } from 'node:stream';

/**
 * Handle for en pågående ZIP-upload.
 *
 *  - `stream`     : Writable som archiver pipes inn i. Closes når archiver
 *                   finalize-r.
 *  - `completion` : Promise som resolver når upload er fullt committed til
 *                   storage. Reject ved upload-feil. ALLTID await etter
 *                   archive.finalize() for å sikre at vi ikke fortsetter
 *                   før alle bytes er trygt på plass.
 */
export interface ZipUploadHandle {
  stream: Writable;
  completion: Promise<void>;
}

export interface OutputBackend {
  /**
   * Identifikator for backend (kun for logging/diagnostikk).
   */
  readonly kind: 'gcs' | 'r2';

  /**
   * Start en streamende upload. Skriving skjer i bakgrunnen mens stream-en
   * tar imot bytes; pipe archiver direkte inn i `stream`. Vent på
   * `completion`-Promise etter `archive.finalize()`.
   */
  createUpload(objectName: string, contentType: string): ZipUploadHandle;

  /**
   * Hent metadata-størrelse for et ferdig opplastet objekt.
   * Brukes etter at upload er committed for å rapportere ZIP-bytes til webhook.
   */
  getObjectSize(objectName: string): Promise<number>;

  /**
   * Generer en kortlevd signed URL for nedlasting (default 7 dager).
   * Brukes i webhook-payload som kunde får på e-post.
   */
  getSignedUrl(objectName: string, expiryDays: number): Promise<string>;
}
