import sharp from 'sharp';
// @ts-ignore — heic-convert mangler types, men API er rett-frem
import convert from 'heic-convert';
import { config } from './config.js';

// HEIC-magic-bytes detection. iPhone-HEIC og PC-HEIF har samme ISO BMFF-container.
// Byte 4-12 inneholder "ftypheic", "ftypheix", "ftypmif1", "ftypmsf1", "ftyphevc" osv.
function isHeic(buf: Buffer): boolean {
  if (buf.byteLength < 12) return false;
  const ftyp = buf.subarray(4, 8).toString('ascii');
  if (ftyp !== 'ftyp') return false;
  const brand = buf.subarray(8, 12).toString('ascii');
  return ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(brand);
}

// Konverter HEIC → JPEG-buffer som Sharp kan lese.
// Sharps bundled libvips mangler HEVC-decoder plugin ('No decoding plugin'-feil)
// så vi pre-prosesserer alle HEIC før Sharp ser dem.
async function heicToJpeg(input: Buffer): Promise<Buffer> {
  const jpegArrayBuffer = await convert({
    buffer: input as unknown as ArrayBuffer,
    format: 'JPEG',
    quality: 0.92,
  });
  return Buffer.from(jpegArrayBuffer);
}

export type Variant = {
  name: 'thumb' | 'medium';
  buffer: Buffer;
  contentType: 'image/webp';
  bytes: number;
};

export type ProcessResult = {
  variants: Variant[];
  sourceBytes: number;
  sourceFormat: string | undefined;
  width: number | undefined;
  height: number | undefined;
  durationMs: number;
};

// Hard cap mot decompression bombs (ikon-bilde som dekoder til 100k×100k).
sharp.cache(false);
sharp.concurrency(1);

export async function processImage(input: Buffer): Promise<ProcessResult> {
  const t0 = Date.now();

  if (input.byteLength > config.maxInputBytes) {
    throw new Error(`Input too large: ${input.byteLength} > ${config.maxInputBytes}`);
  }

  // Pre-konvertering hvis HEIC/HEIF (Sharp's libvips mangler HEVC-decoder).
  // heic-convert er WASM-basert og funker uten native deps.
  let working = input;
  if (isHeic(input)) {
    console.log(`[HEIC] pre-konverterer ${input.byteLength} bytes til JPEG før Sharp`);
    working = await heicToJpeg(input);
    console.log(`[HEIC] → JPEG ${working.byteLength} bytes (${Math.round(working.byteLength / input.byteLength * 100)}% av original)`);
  }

  // failOn: 'truncated' = aksepter mindre EXIF-feil, men avvis korrupte bilder.
  // .rotate() = auto-rotér basert på EXIF Orientation, FØR vi stripper metadata.
  const base = sharp(working, { failOn: 'truncated', limitInputPixels: 268_402_689 }).rotate();

  const meta = await base.metadata();

  const [thumbBuf, mediumBuf] = await Promise.all([
    base
      .clone()
      .resize(config.thumbSize, config.thumbSize, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: config.thumbQuality, effort: 4 })
      .toBuffer(),
    base
      .clone()
      .resize(config.mediumSize, config.mediumSize, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: config.mediumQuality, effort: 4 })
      .toBuffer(),
  ]);

  return {
    variants: [
      { name: 'thumb', buffer: thumbBuf, contentType: 'image/webp', bytes: thumbBuf.byteLength },
      { name: 'medium', buffer: mediumBuf, contentType: 'image/webp', bytes: mediumBuf.byteLength },
    ],
    sourceBytes: input.byteLength,
    sourceFormat: meta.format,
    width: meta.width,
    height: meta.height,
    durationMs: Date.now() - t0,
  };
}
