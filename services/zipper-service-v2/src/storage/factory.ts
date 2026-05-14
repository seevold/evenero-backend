// Factory som velger riktig OutputBackend basert på config.
// Beholder begge tilgjengelig så instant rollback via env-flag fungerer.

import { config } from '../config.js';
import { GcsBackend } from './gcs-backend.js';
import { R2Backend } from './r2-backend.js';
import type { OutputBackend } from './interface.js';

let cached: OutputBackend | null = null;

export function getOutputBackend(): OutputBackend {
  if (cached) return cached;

  if (config.zipOutput === 'r2') {
    cached = new R2Backend({
      accountId: config.r2.accountId,
      accessKeyId: config.r2.accessKeyId,
      secretAccessKey: config.r2.secretAccessKey,
      bucket: config.r2.bucket,
      jurisdiction: config.r2.jurisdiction,
    });
  } else {
    cached = new GcsBackend(config.bucket);
  }
  return cached;
}
