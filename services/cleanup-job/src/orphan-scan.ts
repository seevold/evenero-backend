// Orphan bucket-scan — kategori 4 i cleanup-planen.
//
// Lister filer under kjente prefixes (originals/, derived/, images/) og krysser
// mot DB-referanser. Filer som IKKE er referert AND eldre enn orphanGraceDays
// klassifiseres som orphan.
//
// Konservativ tilnærming:
//  - Kun kjente prefixes scannes. Ukjente paths ignoreres helt.
//  - Alder-filter (orphanGraceDays) beskytter mot race med pågående uploads.
//  - Cover-paths sjekkes mot events.event_photo (alle aktive eventer + grace-perioden).
//
// Returnerer kandidater for sletting — selve sletting + caps håndteres av main loop.

import type { File as GCSFile } from "@google-cloud/storage";
import { listFilesWithMetadata } from "./gcs.js";
import type { DbReferences } from "./queries.js";

export interface OrphanCandidate {
  path: string;
  size: number;
  ageInDays: number;
  reason: "v2_original_no_db_row" | "v2_derived_no_source" | "v1_image_no_db_row" | "cover_orphan" | "old_zip";
}

function ageDays(file: GCSFile): number {
  const updated = file.metadata.updated || file.metadata.timeCreated;
  if (!updated) return 0;
  const t = new Date(updated as string).getTime();
  return (Date.now() - t) / (1000 * 60 * 60 * 24);
}

function sizeOf(file: GCSFile): number {
  const s = file.metadata.size;
  if (typeof s === "string") return parseInt(s, 10);
  if (typeof s === "number") return s;
  return 0;
}

export async function scanOrphans(
  refs: DbReferences,
  orphanGraceDays: number,
): Promise<OrphanCandidate[]> {
  const candidates: OrphanCandidate[] = [];

  // ---- Scan originals/ ----
  // v2-format: originals/{eventId}/{mediaId}.{ext}
  // Orphan hvis: path ikke i imagePaths (= ingen event_images-rad med denne URL)
  const originals = await listFilesWithMetadata("originals/");
  console.log(`[ORPHAN-SCAN] Found ${originals.length} files in originals/`);
  for (const f of originals) {
    if (ageDays(f) < orphanGraceDays) continue;
    if (refs.imagePaths.has(f.name)) continue;
    candidates.push({
      path: f.name,
      size: sizeOf(f),
      ageInDays: ageDays(f),
      reason: "v2_original_no_db_row",
    });
  }

  // ---- Scan derived/ ----
  // Format: derived/{eventId}/{mediaId}/{thumb,medium,poster,preview}.{ext}
  // Orphan hvis: (eventId, mediaId)-paret ikke finnes i v2EventMediaPairs.
  const derived = await listFilesWithMetadata("derived/");
  console.log(`[ORPHAN-SCAN] Found ${derived.length} files in derived/`);
  for (const f of derived) {
    if (ageDays(f) < orphanGraceDays) continue;

    // Spesialcase: derived/zip/{jobId}.zip har lifecycle-rule på 7 dager.
    // Vi tar dem med her hvis lifecycle ikke har gjort jobben.
    if (f.name.startsWith("derived/zip/")) {
      if (ageDays(f) > 7) {
        candidates.push({
          path: f.name,
          size: sizeOf(f),
          ageInDays: ageDays(f),
          reason: "old_zip",
        });
      }
      continue;
    }

    const m = f.name.match(/^derived\/([^/]+)\/([^/]+)\//);
    if (!m) continue; // ukjent format under derived/ — skip
    const pair = `${m[1]}/${m[2]}`;
    if (refs.v2EventMediaPairs.has(pair)) continue;
    candidates.push({
      path: f.name,
      size: sizeOf(f),
      ageInDays: ageDays(f),
      reason: "v2_derived_no_source",
    });
  }

  // ---- Scan images/ (v1 legacy) ----
  // Format: images/{filename}.{ext} (flat). Også derivat (_small/_compressed).
  // Orphan hvis: path ikke i imagePaths AND ikke i coverPaths.
  //
  // VIKTIG: vi sjekker både original og derivat. Hvis original = images/foo.jpg
  // er referert, så er images/foo_small.jpg automatisk OK (samme bilde).
  const images = await listFilesWithMetadata("images/");
  console.log(`[ORPHAN-SCAN] Found ${images.length} files in images/`);
  for (const f of images) {
    if (ageDays(f) < orphanGraceDays) continue;

    // Avled "original-pathen" fra evt derivat-navn:
    // foo_small.jpg → foo.jpg, foo_compressed.mp4 → foo.mp4
    const stripped = stripDerivativeSuffix(f.name);

    if (refs.imagePaths.has(f.name)) continue;
    if (refs.imagePaths.has(stripped)) continue;
    if (refs.coverPaths.has(f.name)) continue;
    if (refs.coverPaths.has(stripped)) continue;

    candidates.push({
      path: f.name,
      size: sizeOf(f),
      ageInDays: ageDays(f),
      reason: "v1_image_no_db_row",
    });
  }

  // ---- Scan covers/ ----
  // Cover-uploads bruker covers/{name} (eller legacy cover-prefiks i filnavn).
  // Orphan hvis: path ikke i coverPaths.
  const covers = await listFilesWithMetadata("covers/");
  console.log(`[ORPHAN-SCAN] Found ${covers.length} files in covers/`);
  for (const f of covers) {
    if (ageDays(f) < orphanGraceDays) continue;
    if (refs.coverPaths.has(f.name)) continue;
    candidates.push({
      path: f.name,
      size: sizeOf(f),
      ageInDays: ageDays(f),
      reason: "cover_orphan",
    });
  }

  return candidates;
}

// Strip _small / _compressed suffiks. Eks:
//   images/foo_small.jpg → images/foo.jpg
//   images/foo_compressed.mp4 → images/foo.mp4
//   images/foo.jpg → images/foo.jpg (no-op)
function stripDerivativeSuffix(path: string): string {
  const lastDot = path.lastIndexOf(".");
  if (lastDot < 0) return path;
  const base = path.slice(0, lastDot);
  const ext = path.slice(lastDot);
  if (base.endsWith("_small")) return base.slice(0, -"_small".length) + ext;
  if (base.endsWith("_compressed")) return base.slice(0, -"_compressed".length) + ext;
  return path;
}
