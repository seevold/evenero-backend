import { spawn } from 'node:child_process';
import { config } from './config.js';
import { ffprobe, shouldSkipReencode, type ProbeResult } from './probe.js';

export type EncodeStrategy = 'remux' | 'reencode';

export type ProcessResult = {
  strategy: EncodeStrategy;
  probe: ProbeResult;
  previewBytes: number;
  posterBytes: number;
  encodeMs: number;
  posterMs: number;
};

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    // ffmpeg skriver progress + alt til stderr; behold siste 2KB for feilmelding.
    proc.stderr.on('data', (d) => {
      stderr += d;
      if (stderr.length > 4096) stderr = stderr.slice(-2048);
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-800)}`));
    });
  });
}

// Strategi 1 — remux: behold codecs, bare reposisjoner moov-atom for streaming.
async function remux(input: string, output: string): Promise<void> {
  await runFfmpeg([
    '-y',
    '-i', input,
    '-c', 'copy',
    '-movflags', '+faststart',
    output,
  ]);
}

// Strategi 2 — fullt re-encode til H.264 720p (eller mindre).
async function reencode(input: string, output: string): Promise<void> {
  await runFfmpeg([
    '-y',
    '-i', input,
    '-c:v', 'libx264',
    '-preset', config.preset,
    '-crf', String(config.crf),
    '-profile:v', 'high',
    '-level', '4.1',
    '-pix_fmt', 'yuv420p',
    '-vf', `scale='min(${config.maxWidth},iw)':-2`,
    '-maxrate', config.maxRate,
    '-bufsize', config.bufSize,
    '-c:a', 'aac',
    '-b:a', config.audioBitrate,
    '-ac', '2',
    '-movflags', '+faststart',
    '-threads', '0',
    output,
  ]);
}

async function makePoster(input: string, output: string): Promise<void> {
  await runFfmpeg([
    '-y',
    '-ss', config.posterTimestamp,
    '-i', input,
    '-frames:v', '1',
    '-vf', `scale=${config.posterWidth}:-2`,
    '-q:v', '4',
    output,
  ]);
}

import { stat } from 'node:fs/promises';

export async function processVideo(
  inputPath: string,
  previewPath: string,
  posterPath: string,
): Promise<ProcessResult> {
  const probe = await ffprobe(inputPath);
  const skip = shouldSkipReencode(probe);

  const t0 = Date.now();
  if (skip) {
    await remux(inputPath, previewPath);
  } else {
    await reencode(inputPath, previewPath);
  }
  const encodeMs = Date.now() - t0;

  const t1 = Date.now();
  await makePoster(inputPath, posterPath);
  const posterMs = Date.now() - t1;

  const [prevStat, postStat] = await Promise.all([stat(previewPath), stat(posterPath)]);

  return {
    strategy: skip ? 'remux' : 'reencode',
    probe,
    previewBytes: prevStat.size,
    posterBytes: postStat.size,
    encodeMs,
    posterMs,
  };
}
