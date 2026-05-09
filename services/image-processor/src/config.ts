function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  bucket: required('GCS_BUCKET_NAME'),

  // Path-skjema. Input matches `${INPUT_PREFIX}/{eventId}/{mediaId}.{ext}`.
  // Output skrives til `${OUTPUT_PREFIX}/{eventId}/{mediaId}/{variant}.webp`.
  inputPrefix: process.env.INPUT_PREFIX || 'originals',
  outputPrefix: process.env.OUTPUT_PREFIX || 'derived',

  // Sharp/WebP-tuning. Endres uten redeploy via Cloud Run env-vars.
  thumbSize: parseInt(process.env.THUMB_SIZE || '384', 10),
  mediumSize: parseInt(process.env.MEDIUM_SIZE || '1600', 10),
  thumbQuality: parseInt(process.env.THUMB_QUALITY || '72', 10),
  mediumQuality: parseInt(process.env.MEDIUM_QUALITY || '78', 10),

  // Maks input-størrelse (sikkerhet mot decompression bombs).
  maxInputBytes: parseInt(process.env.MAX_INPUT_BYTES || String(50 * 1024 * 1024), 10),

  port: parseInt(process.env.PORT || '8080', 10),
};
