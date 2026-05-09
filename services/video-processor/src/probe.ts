import { spawn } from 'node:child_process';
import { config } from './config.js';

export type ProbeResult = {
  durationSec: number;
  width: number;
  height: number;
  videoCodec: string;
  audioCodec: string | null;
  bitrate: number; // bits per second
  format: string;
};

type FfprobeStream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
};

type FfprobeFormat = {
  duration?: string;
  bit_rate?: string;
  format_name?: string;
};

type FfprobeOutput = {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
};

export async function ffprobe(filePath: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath,
    ]);

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`ffprobe exit ${code}: ${stderr}`));
      }
      try {
        const data: FfprobeOutput = JSON.parse(stdout);
        const video = data.streams?.find((s) => s.codec_type === 'video');
        const audio = data.streams?.find((s) => s.codec_type === 'audio');
        if (!video) return reject(new Error('No video stream found'));

        resolve({
          durationSec: parseFloat(data.format?.duration ?? '0'),
          width: video.width ?? 0,
          height: video.height ?? 0,
          videoCodec: video.codec_name ?? 'unknown',
          audioCodec: audio?.codec_name ?? null,
          bitrate: parseInt(data.format?.bit_rate ?? '0', 10),
          format: data.format?.format_name ?? 'unknown',
        });
      } catch (e) {
        reject(new Error(`Failed to parse ffprobe output: ${(e as Error).message}`));
      }
    });
  });
}

// Smart-skip: hvis source allerede er web-friendly H.264 ≤ skipMaxWidth ≤ skipMaxBitrate,
// trenger vi bare å remux med +faststart (1-3 sek vs minutter).
export function shouldSkipReencode(probe: ProbeResult): boolean {
  if (!config.skipCodecs.includes(probe.videoCodec)) return false;
  if (probe.width > config.skipMaxWidth) return false;
  if (probe.bitrate > config.skipMaxBitrate) return false;
  return true;
}
