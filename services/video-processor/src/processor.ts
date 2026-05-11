import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { config } from './config.js';
import { ffprobe, shouldSkipReencode, type ProbeResult } from './probe.js';

export type EncodeStrategy = 'remux' | 'reencode' | 'skipped-too-long' | 'skipped-too-big' | 'skipped-encode-timeout';

export type ProcessResult = {
  strategy: EncodeStrategy;
  probe: ProbeResult;
  previewBytes: number | null;  // null hvis preview ble skipped
  posterBytes: number;
  encodeMs: number;
  posterMs: number;
};

function runFfmpeg(args: string[], timeoutMs?: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += d;
      if (stderr.length > 4096) stderr = stderr.slice(-2048);
    });

    let timer: NodeJS.Timeout | null = null;
    let killedByTimeout = false;
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        killedByTimeout = true;
        proc.kill('SIGKILL');
      }, timeoutMs);
    }

    proc.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (killedByTimeout) {
        const err = new Error(`ffmpeg killed after timeout (${timeoutMs}ms)`);
        (err as { code?: string }).code = 'ENCODE_TIMEOUT';
        return reject(err);
      }
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-800)}`));
    });
  });
}

async function remux(input: string, output: string, timeoutMs: number): Promise<void> {
  await runFfmpeg([
    '-y', '-i', input,
    '-c', 'copy',
    '-movflags', '+faststart',
    output,
  ], timeoutMs);
}

async function reencode(input: string, output: string, timeoutMs: number): Promise<void> {
  await runFfmpeg([
    '-y', '-i', input,
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
  ], timeoutMs);
}

async function makePoster(input: string, output: string): Promise<void> {
  // Kort timeout — poster er bare første frame.
  await runFfmpeg([
    '-y',
    '-ss', config.posterTimestamp,
    '-i', input,
    '-frames:v', '1',
    '-vf', `scale=${config.posterWidth}:-2`,
    '-q:v', '4',
    output,
  ], 60_000);
}

// Avgjør om vi skal hoppe over preview-encoding helt.
// Frontend faller da tilbake til original-fila.
function shouldSkipPreview(
  probe: ProbeResult,
  sourceBytes: number,
): EncodeStrategy | null {
  if (probe.durationSec > config.maxPreviewDurationSec) return 'skipped-too-long';
  if (sourceBytes > config.maxPreviewBytes) return 'skipped-too-big';
  return null;
}

export async function processVideo(
  inputPath: string,
  previewPath: string,
  posterPath: string,
  sourceBytes: number,
): Promise<ProcessResult> {
  const probe = await ffprobe(inputPath);

  // Poster genereres ALLTID — billig (~1-2 sek), kritisk for galleri.
  const posterStart = Date.now();
  await makePoster(inputPath, posterPath);
  const posterMs = Date.now() - posterStart;
  const posterStat = await stat(posterPath);

  // Avgjør om preview skal genereres
  const skipReason = shouldSkipPreview(probe, sourceBytes);
  if (skipReason) {
    return {
      strategy: skipReason,
      probe,
      previewBytes: null,
      posterBytes: posterStat.size,
      encodeMs: 0,
      posterMs,
    };
  }

  const encodeStart = Date.now();
  let strategy: EncodeStrategy = shouldSkipReencode(probe) ? 'remux' : 'reencode';

  try {
    if (strategy === 'remux') {
      try {
        await remux(inputPath, previewPath, config.encodeTimeoutMs);
      } catch (remuxErr) {
        // Remux (-c copy) feiler hvis kildens audio/video-codec ikke kan
        // pakkes inn i mp4-container uten transkoding. Klassisk eksempel:
        // gamle .mov-filer med adpcm_ima_wav-audio. Fallback til full
        // reencode som alltid produserer kompatibel H.264+AAC mp4.
        const code = (remuxErr as { code?: string }).code;
        if (code === 'ENCODE_TIMEOUT') throw remuxErr;
        console.warn('[video-processor] Remux feilet, faller tilbake til reencode:',
          remuxErr instanceof Error ? remuxErr.message.split('\n')[0] : String(remuxErr));
        strategy = 'reencode';
        await reencode(inputPath, previewPath, config.encodeTimeoutMs);
      }
    } else {
      await reencode(inputPath, previewPath, config.encodeTimeoutMs);
    }
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ENCODE_TIMEOUT') {
      // Best-effort: encode tok for lang tid. Hopper, frontend faller tilbake.
      return {
        strategy: 'skipped-encode-timeout',
        probe,
        previewBytes: null,
        posterBytes: posterStat.size,
        encodeMs: Date.now() - encodeStart,
        posterMs,
      };
    }
    throw err; // Ekte ffmpeg-feil — la handleren returnere 500.
  }

  const previewStat = await stat(previewPath);

  return {
    strategy,
    probe,
    previewBytes: previewStat.size,
    posterBytes: posterStat.size,
    encodeMs: Date.now() - encodeStart,
    posterMs,
  };
}
