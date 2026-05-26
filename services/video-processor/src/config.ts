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

  // Hard cap mot megastore videoer (skipper med en gang, lar frontend bruke original).
  // Selv om vi nå streamer input via HTTP (ikke download til tmpfs), tar selve
  // encoding for stort grunnlag absurd lang tid på 4 vCPU og treffer encodeTimeoutMs.
  // 1 GB er nok for 4K-videoer på flere minutter — alt over er sannsynligvis et
  // sluttbruker-misforståelse uansett.
  maxInputBytes: parseInt(process.env.MAX_INPUT_BYTES || String(1 * 1024 * 1024 * 1024), 10), // 1 GB

  // Best-effort caps: hvis source er over disse, hopper vi over preview-encoding
  // og lar frontend falle tilbake på original. Skipped-flag skrives så frontend
  // vet det med en gang (slipper å vente på timeout).
  // Poster genereres uansett (1-2 sek ffmpeg, kan ikke feile).
  maxPreviewDurationSec: parseInt(process.env.MAX_PREVIEW_DURATION_SEC || '300', 10),  // 5 min
  maxPreviewBytes: parseInt(process.env.MAX_PREVIEW_BYTES || String(500 * 1024 * 1024), 10), // 500 MB

  // Hvis ffmpeg fortsatt henger over denne tiden, drep prosessen og fall tilbake
  // til skipped-flag. Lavere enn Pub/Sub ack-deadline (600s) for å unngå redelivery.
  encodeTimeoutMs: parseInt(process.env.ENCODE_TIMEOUT_MS || '480000', 10), // 8 min

  // Poster-frame.
  posterTimestamp: process.env.POSTER_TIMESTAMP || '00:00:01',
  posterWidth: parseInt(process.env.POSTER_WIDTH || '400', 10),

  port: parseInt(process.env.PORT || '8080', 10),
  tmpDir: process.env.TMPDIR || '/tmp',
};
