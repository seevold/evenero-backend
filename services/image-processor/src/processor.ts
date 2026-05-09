import sharp from 'sharp';
import { config } from './config.js';

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

  // failOn: 'truncated' = aksepter mindre EXIF-feil, men avvis korrupte bilder.
  // .rotate() = auto-rotér basert på EXIF Orientation, FØR vi stripper metadata.
  const base = sharp(input, { failOn: 'truncated', limitInputPixels: 268_402_689 }).rotate();

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
