function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  bucket: required('GCS_BUCKET_NAME'),

  inputPrefix: process.env.INPUT_PREFIX || 'originals',
  outputPrefix: process.env.OUTPUT_PREFIX || 'derived',

  // Encode-tuning (kan endres uten redeploy via Cloud Run env-vars).
  maxWidth: parseInt(process.env.MAX_WIDTH || '1280', 10),
  crf: parseInt(process.env.CRF || '24', 10),
  preset: process.env.PRESET || 'veryfast',
  maxRate: process.env.MAX_RATE || '4M',
  bufSize: process.env.BUF_SIZE || '8M',
  audioBitrate: process.env.AUDIO_BITRATE || '128k',

  // Smart-skip-terskler. Hvis source matcher ALLE: bare remux (-c copy).
  skipMaxWidth: parseInt(process.env.SKIP_MAX_WIDTH || '1280', 10),
  skipMaxBitrate: parseInt(process.env.SKIP_MAX_BITRATE || '4500000', 10), // 4.5 Mbps
  skipCodecs: (process.env.SKIP_CODECS || 'h264').split(','),

  // Hard cap mot megastore videoer.
  maxInputBytes: parseInt(process.env.MAX_INPUT_BYTES || String(5 * 1024 * 1024 * 1024), 10), // 5 GB

  // Poster-frame.
  posterTimestamp: process.env.POSTER_TIMESTAMP || '00:00:01',
  posterWidth: parseInt(process.env.POSTER_WIDTH || '400', 10),

  port: parseInt(process.env.PORT || '8080', 10),
  tmpDir: process.env.TMPDIR || '/tmp',
};
