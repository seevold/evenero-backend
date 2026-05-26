import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { config } from './config.js';
import { ffprobe, shouldSkipReencode, type ProbeResult } from './probe.js';

export type EncodeStrategy = 'remux' | 'reencode' | 'skipped-too-long' | 'skipped-too-big' | 'skipped-encode-timeout' | 'skipped-poster-failed';

export type ProcessResult = {
  strategy: EncodeStrategy;
  probe: ProbeResult;
  previewBytes: number | null;  // null hvis preview ble skipped
  posterBytes: number | null;   // null hvis poster ikke ble generert (skipped-poster-failed)
  encodeMs: number;
  posterMs: number;
};

// Standardiserte ffmpeg HTTP-reconnect-flags. Må komme FØR -i når inputen
// er en URL — input vil være en signed GCS URL i prod, ikke en lokal fil,
// og ffmpeg kan miste tilkoblingen midt under encoding av lange videoer.
const HTTP_RECONNECT_FLAGS = [
  '-reconnect', '1',
  '-reconnect_streamed', '1',
  '-reconnect_on_network_error', '1',
  '-reconnect_on_http_error', '5xx',
  '-reconnect_delay_max', '30',
];

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
    '-y',
    ...HTTP_RECONNECT_FLAGS,
    '-i', input,
    '-c', 'copy',
    '-movflags', '+faststart',
    output,
  ], timeoutMs);
}

async function reencode(input: string, output: string, timeoutMs: number): Promise<void> {
  await runFfmpeg([
    '-y',
    ...HTTP_RECONNECT_FLAGS,
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
  ], timeoutMs);
}

// Parse "HH:MM:SS[.ms]" eller en tallstreng ("1.5") til sekunder.
// Faller tilbake til 0 hvis input ikke kan tolkes.
function parseTimestampToSec(s: string): number {
  if (s.includes(':')) {
    const parts = s.split(':').map(parseFloat);
    if (parts.some((n) => Number.isNaN(n))) return 0;
    const [h, m, sec] = parts.length === 3 ? parts : [0, parts[0] ?? 0, parts[1] ?? 0];
    return h * 3600 + m * 60 + sec;
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

async function makePoster(input: string, output: string, durationSec: number): Promise<void> {
  // Kort timeout — poster er bare første frame.
  // Klamp seek-tid til durationSec/2 så vi alltid treffer en faktisk frame —
  // ellers vil videoer kortere enn posterTimestamp gi exit 0 uten output
  // (ffmpeg seeker forbi slutten). Midtpunktet er en grei thumbnail for
  // korte klipp og bevarer "1 sek inn"-oppførselen for normale videoer.
  const targetSec = parseTimestampToSec(config.posterTimestamp);
  const effectiveSec = durationSec > 0 ? Math.min(targetSec, durationSec / 2) : 0;
  await runFfmpeg([
    '-y',
    ...HTTP_RECONNECT_FLAGS,
    '-ss', effectiveSec.toFixed(3),
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
  /**
   * Callback som fyrer SÅ SNART poster.jpg er ferdig generert, men FØR
   * preview-encoding starter. Lar caller laste opp poster umiddelbart i
   * parallell med encoding, slik at galleri-thumbnail er tilgjengelig
   * etter sekunder selv om encode tar minutter.
   */
  onPosterReady?: (posterPath: string, posterBytes: number) => void | Promise<void>,
): Promise<ProcessResult> {
  const probe = await ffprobe(inputPath);

  // Poster: best-effort. Vanlig (~1-2 sek), men noen rare codecs / korte
  // videoer / korrupte filer får ffmpeg til å exit 0 uten å skrive output,
  // eller å feile på et vis vi ikke kan forutse. Hvis det skjer skipper vi
  // hele jobben i stedet for å returnere 500 og forårsake Pub/Sub retry-storm.
  const posterStart = Date.now();
  let posterStat: { size: number } | null = null;
  try {
    await makePoster(inputPath, posterPath, probe.durationSec);
    posterStat = await stat(posterPath);
  } catch (posterErr) {
    return {
      strategy: 'skipped-poster-failed',
      probe,
      previewBytes: null,
      posterBytes: null,
      encodeMs: 0,
      posterMs: Date.now() - posterStart,
    };
  }
  const posterMs = Date.now() - posterStart;

  // Varsle caller om at poster er klar — de starter upload i parallell
  // med encoding under
  if (onPosterReady) {
    await onPosterReady(posterPath, posterStat.size);
  }

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
