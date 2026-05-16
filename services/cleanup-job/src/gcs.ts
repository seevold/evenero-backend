// GCS-hjelpere — gjenbruker mønsteret fra main-api/gcs.ts.
// Bare det vi trenger: list, delete, deletePrefix, extractGcsPath, derivative-paths.

import { Storage, type File as GCSFile } from "@google-cloud/storage";
import { config } from "./config.js";

const storage = new Storage({
  projectId: process.env.GCP_PROJECT_ID || "evenero",
});

console.log(`[GCS] Initialized with ADC, bucket=${config.gcsBucket}`);

export async function deleteFile(filename: string): Promise<boolean> {
  try {
    await storage.bucket(config.gcsBucket).file(filename).delete();
    return true;
  } catch (error: any) {
    if (error?.code === 404) {
      // Idempotent: allerede slettet eller eksisterte aldri
      return true;
    }
    console.error(`[GCS] Failed to delete ${filename}:`, error?.message || error);
    return false;
  }
}

export async function deletePrefix(prefix: string): Promise<number> {
  try {
    const bucket = storage.bucket(config.gcsBucket);
    const [files] = await bucket.getFiles({ prefix });
    if (files.length === 0) return 0;
    await Promise.all(files.map((f) => f.delete({ ignoreNotFound: true } as any)));
    return files.length;
  } catch (error: any) {
    console.error(`[GCS] Failed to delete prefix ${prefix}:`, error?.message || error);
    return 0;
  }
}

// List files under prefix — returnerer full File-objekter med metadata
// (size, last_modified). Brukt av orphan-scanner som trenger å filtrere på alder.
export async function listFilesWithMetadata(prefix: string): Promise<GCSFile[]> {
  try {
    const bucket = storage.bucket(config.gcsBucket);
    const [files] = await bucket.getFiles({ prefix });
    return files;
  } catch (error: any) {
    console.error(`[GCS] Failed to list ${prefix}:`, error?.message || error);
    return [];
  }
}

// Extract GCS-path fra full URL eller gs://-URI. Returnerer null hvis URL
// peker på en annen bucket (ulik vår config.gcsBucket).
export function extractGcsPath(url: string | null | undefined): string | null {
  if (!url || typeof url !== "string") return null;

  const httpsMatch = url.match(/^https?:\/\/storage\.googleapis\.com\/([^/]+)\/(.+?)(?:\?|$)/);
  if (httpsMatch) {
    const [, bucket, path] = httpsMatch;
    if (bucket !== config.gcsBucket) {
      console.warn(`[GCS] URL refererer bucket '${bucket}' ulik config.gcsBucket='${config.gcsBucket}'`);
      return null;
    }
    return decodeURIComponent(path);
  }

  const gsMatch = url.match(/^gs:\/\/([^/]+)\/(.+)$/);
  if (gsMatch) {
    const [, bucket, path] = gsMatch;
    if (bucket !== config.gcsBucket) {
      console.warn(`[GCS] gs:// refererer '${bucket}' ulik config.gcsBucket='${config.gcsBucket}'`);
      return null;
    }
    return path;
  }

  return null;
}

const VIDEO_EXTS = ["mp4", "mov", "avi", "wmv", "webm", "mkv", "m4v", "3gp"];

// Bygg liste av GCS-paths som skal slettes for en gitt event_image-rad.
// Returnerer både v1- og v2-paths basert på image_url-format.
//
// v2: originals/{ev}/{med}.ext + alle filer under derived/{ev}/{med}/
// v1: images/{name}.ext + images/{name}_small.ext (bilde) / _compressed.ext (video)
//
// Bruk: kall denne for hver rad du vil purge, før sletting. Returnerer:
//   - originalPath: hovedfil (alltid satt hvis v2 eller v1 matchet)
//   - derivedPrefix: prefix å slette under (v2 only) — null hvis v1
//   - derivativePath: enkelt derivative-fil (v1 only) — null hvis v2
//   - isV2: true hvis v2-format
export interface PathPlan {
  originalPath: string | null;
  derivedPrefix: string | null;
  derivativePath: string | null;
  isV2: boolean;
}

export function buildPathPlan(imageUrl: string | null, fileExtension: string | null): PathPlan {
  const gcsPath = extractGcsPath(imageUrl);
  if (!gcsPath) {
    return { originalPath: null, derivedPrefix: null, derivativePath: null, isV2: false };
  }

  // v2: originals/{eventId}/{mediaId}.{ext}
  const v2Match = gcsPath.match(/^originals\/([^/]+)\/([^/]+)\.[^./]+$/);
  if (v2Match) {
    const [, evId, medId] = v2Match;
    return {
      originalPath: gcsPath,
      derivedPrefix: `derived/${evId}/${medId}/`,
      derivativePath: null,
      isV2: true,
    };
  }

  // v1: images/{filename}.{ext} — også _small/_compressed-derivat
  const filename = gcsPath.replace(/^images\//, "");
  if (filename === gcsPath) {
    // Ikke v1 heller (ikke under images/) — kan være cover eller noe annet
    return { originalPath: gcsPath, derivedPrefix: null, derivativePath: null, isV2: false };
  }

  const lastDot = filename.lastIndexOf(".");
  const ext = lastDot > 0 ? filename.slice(lastDot + 1).toLowerCase() : "";
  const isVideo =
    VIDEO_EXTS.includes(ext) ||
    (fileExtension ? VIDEO_EXTS.includes(fileExtension.toLowerCase().replace(".", "")) : false);
  const derivativeSuffix = isVideo ? "_compressed" : "_small";
  const derivativeFilename =
    lastDot > 0
      ? filename.slice(0, lastDot) + derivativeSuffix + filename.slice(lastDot)
      : filename + derivativeSuffix;

  return {
    originalPath: gcsPath,
    derivedPrefix: null,
    derivativePath: `images/${derivativeFilename}`,
    isV2: false,
  };
}
