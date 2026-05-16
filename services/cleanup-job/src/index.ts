// Cleanup-job — Cloud Run Job, triggers fra Cloud Scheduler (daglig 03:00 Europe/Oslo).
//
// Kjøreflyt:
//   1. Hent kandidater fra DB (kategori 1-3: archived/rejected/event_deleted >graceDays).
//   2. Hvis CLEANUP_SCAN_ORPHANS=true: list bucket-prefixes og kryss mot DB-referanser
//      → kategori 4 (orphan GCS-filer).
//   3. Caps + halt-on-anomaly-sjekk. Hvis trigget: alert + exit.
//   4. Slett (eller bare logg hvis DRY_RUN=true). Marker files_purged_at i DB.
//   5. Skriv summary til stdout (Cloud Logging fanger den).
//
// Safety:
//   - DRY_RUN=true er DEFAULT. Eksplisitt CLEANUP_DRY_RUN=false må settes for live.
//   - Caps: max 1000 filer + 10 GB per kjøring.
//   - Anomaly: hvis denne kjøringen treffer >5× forrige run (sammenligning mangler i v1).
//   - Aktive coverphotos og aktive event_images.image_url er beskyttet via DB-referanse-set.
//
// v1: kjør med CLEANUP_SCAN_ORPHANS=false først (kun kategori 1-3) til vi har bekreftet
// at klassifisering er korrekt. Skru på orphan-scan i en senere kjøring.

import { config } from "./config.js";
import { pool } from "./db.js";
import {
  buildPathPlan,
  deleteFile,
  deletePrefix,
} from "./gcs.js";
import {
  findArchivedToPurge,
  findRejectedToPurge,
  findFromDeletedEventsToPurge,
  loadDbReferences,
  markPurged,
  type PurgeCandidate,
} from "./queries.js";
import { scanOrphans, type OrphanCandidate } from "./orphan-scan.js";
import { sendAlert } from "./alert.js";

interface RunSummary {
  bucket: string;
  dryRun: boolean;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number;
  ruleBased: {
    archived: number;
    rejected: number;
    eventDeleted: number;
  };
  orphans: {
    total: number;
    byReason: Record<string, number>;
  };
  totals: {
    candidateRows: number;
    candidateFiles: number;
    bytesEstimate: number;
    deletedFiles: number;
    deletedBytes: number;
    skippedDueToCaps: number;
    failures: number;
  };
  haltReason: string | null;
}

const summary: RunSummary = {
  bucket: config.gcsBucket,
  dryRun: config.dryRun,
  startedAt: new Date(),
  finishedAt: null,
  durationMs: 0,
  ruleBased: { archived: 0, rejected: 0, eventDeleted: 0 },
  orphans: { total: 0, byReason: {} },
  totals: {
    candidateRows: 0,
    candidateFiles: 0,
    bytesEstimate: 0,
    deletedFiles: 0,
    deletedBytes: 0,
    skippedDueToCaps: 0,
    failures: 0,
  },
  haltReason: null,
};

function logBanner() {
  console.log("==========================================================");
  console.log(`[CLEANUP-JOB] Starting`);
  console.log(`  bucket:     ${config.gcsBucket}`);
  console.log(`  dryRun:     ${config.dryRun}`);
  console.log(`  graceDays:  ${config.graceDays}`);
  console.log(`  scanOrphans: ${config.scanOrphans}`);
  console.log(`  maxFiles:   ${config.maxFilesPerRun}`);
  console.log(`  maxBytes:   ${config.maxBytesPerRun}`);
  console.log("==========================================================");
}

async function main() {
  logBanner();

  // ---- Phase 1: Hent kandidater fra DB ----
  const archived = await findArchivedToPurge(config.graceDays);
  const rejected = await findRejectedToPurge(config.graceDays);
  const evDeleted = await findFromDeletedEventsToPurge(config.graceDays);
  summary.ruleBased.archived = archived.length;
  summary.ruleBased.rejected = rejected.length;
  summary.ruleBased.eventDeleted = evDeleted.length;

  // Dedupliser på id — en rad kan matche flere kriterier (f.eks. arkivert OG
  // tilhører soft-deleted event). Vi vil bare slette én gang.
  const ruleCandidatesById = new Map<string, PurgeCandidate>();
  for (const c of [...archived, ...rejected, ...evDeleted]) {
    if (!ruleCandidatesById.has(c.id)) ruleCandidatesById.set(c.id, c);
  }
  const ruleCandidates = [...ruleCandidatesById.values()];
  summary.totals.candidateRows = ruleCandidates.length;

  console.log(
    `[PHASE-1] Rule-based candidates: archived=${archived.length}, rejected=${rejected.length}, event_deleted=${evDeleted.length}, deduped=${ruleCandidates.length}`,
  );

  // ---- Phase 2 (optional): Orphan bucket scan ----
  let orphans: OrphanCandidate[] = [];
  if (config.scanOrphans) {
    const refs = await loadDbReferences(config.graceDays);
    orphans = await scanOrphans(refs, config.orphanGraceDays);
    summary.orphans.total = orphans.length;
    for (const o of orphans) {
      summary.orphans.byReason[o.reason] = (summary.orphans.byReason[o.reason] || 0) + 1;
    }
    console.log(`[PHASE-2] Orphan candidates: ${orphans.length}`);
    for (const [reason, count] of Object.entries(summary.orphans.byReason)) {
      console.log(`           ${reason}: ${count}`);
    }
  } else {
    console.log(`[PHASE-2] Orphan scan disabled (CLEANUP_SCAN_ORPHANS=false)`);
  }

  // ---- Phase 3: Caps-sjekk + halt-on-anomaly ----
  const totalCandidateFiles = ruleCandidates.length + orphans.length;
  const orphanBytesEstimate = orphans.reduce((s, o) => s + o.size, 0);
  const ruleBytesEstimate = ruleCandidates.reduce((s, c) => s + (c.file_size || 0), 0);
  summary.totals.candidateFiles = totalCandidateFiles;
  summary.totals.bytesEstimate = orphanBytesEstimate + ruleBytesEstimate;

  if (totalCandidateFiles > config.maxFilesPerRun) {
    summary.haltReason = `Candidate files ${totalCandidateFiles} > MAX_FILES_PER_RUN ${config.maxFilesPerRun}`;
    console.error(`[HALT] ${summary.haltReason}`);
    await sendAlert(
      "HALT: too many candidates",
      `Cleanup-job aborted before any deletion.\n\n` +
        `Bucket: ${config.gcsBucket}\n` +
        `Candidates: ${totalCandidateFiles} (rule=${ruleCandidates.length}, orphan=${orphans.length})\n` +
        `Cap:        ${config.maxFilesPerRun}\n\n` +
        `Action: review classification, possibly raise cap or run in batches.`,
    );
    return finish();
  }

  if (summary.totals.bytesEstimate > config.maxBytesPerRun) {
    summary.haltReason = `Estimated bytes ${summary.totals.bytesEstimate} > MAX_BYTES_PER_RUN ${config.maxBytesPerRun}`;
    console.error(`[HALT] ${summary.haltReason}`);
    await sendAlert(
      "HALT: byte cap exceeded",
      `Cleanup-job aborted before any deletion.\n\n` +
        `Bucket: ${config.gcsBucket}\n` +
        `Estimated bytes: ${summary.totals.bytesEstimate}\n` +
        `Cap:             ${config.maxBytesPerRun}\n`,
    );
    return finish();
  }

  // ---- Phase 4: Eksekver (eller dry-run logg) ----
  if (config.dryRun) {
    console.log("[DRY-RUN] No files will be deleted. Showing first 50 of each category.");
    logSamples(archived, "ARCHIVED (sample)");
    logSamples(rejected, "REJECTED (sample)");
    logSamples(evDeleted, "EVENT-DELETED (sample)");
    if (orphans.length > 0) {
      console.log("[DRY-RUN] ORPHAN candidates (sample):");
      for (const o of orphans.slice(0, 50)) {
        console.log(`  ${o.reason.padEnd(28)} ${o.path} (${formatBytes(o.size)}, ${o.ageInDays.toFixed(0)}d)`);
      }
    }
    return finish();
  }

  // Live mode: slett rule-baserte først, deretter orphans
  for (const c of ruleCandidates) {
    await purgeRuleCandidate(c);
  }
  for (const o of orphans) {
    await purgeOrphan(o);
  }

  return finish();
}

function logSamples(arr: PurgeCandidate[], header: string) {
  if (arr.length === 0) return;
  console.log(`[DRY-RUN] ${header} — total ${arr.length}`);
  for (const c of arr.slice(0, 50)) {
    const plan = buildPathPlan(c.image_url, c.file_extension);
    const paths = [plan.originalPath, plan.derivedPrefix, plan.derivativePath].filter(Boolean).join(", ");
    console.log(
      `  id=${c.id} event=${c.event_id} trigger=${c.trigger_at.toISOString()} v2=${plan.isV2} paths=${paths}`,
    );
  }
}

async function purgeRuleCandidate(c: PurgeCandidate) {
  const plan = buildPathPlan(c.image_url, c.file_extension);
  if (!plan.originalPath) {
    console.warn(`[SKIP] Could not parse image_url for id=${c.id}: ${c.image_url}`);
    summary.totals.failures++;
    return;
  }

  let originalDeleted = false;
  try {
    originalDeleted = await deleteFile(plan.originalPath);
  } catch (e) {
    console.error(`[FAIL] delete ${plan.originalPath}:`, e);
  }

  if (!originalDeleted) {
    summary.totals.failures++;
    console.error(`[FAIL] Original delete failed for id=${c.id}, leaving files_purged_at unset`);
    return;
  }

  let derivedDeleted = 0;
  if (plan.derivedPrefix) {
    try {
      derivedDeleted = await deletePrefix(plan.derivedPrefix);
    } catch (e) {
      console.error(`[WARN] derived prefix delete failed for ${plan.derivedPrefix}:`, e);
    }
  } else if (plan.derivativePath) {
    try {
      const ok = await deleteFile(plan.derivativePath);
      if (ok) derivedDeleted = 1;
    } catch (e) {
      console.error(`[WARN] derivative delete failed for ${plan.derivativePath}:`, e);
    }
  }

  // Marker files_purged_at i DB. Vi gjør dette én rad om gangen for å unngå
  // partielle batch-feil — minimal overhead siden caps holder antall lavt.
  await markPurged([c.id]);

  summary.totals.deletedFiles += 1 + derivedDeleted;
  summary.totals.deletedBytes += c.file_size || 0;

  console.log(
    `[PURGED] cat=${c.category} id=${c.id} v2=${plan.isV2} original=${plan.originalPath} derived=${derivedDeleted}`,
  );
}

async function purgeOrphan(o: OrphanCandidate) {
  try {
    const ok = await deleteFile(o.path);
    if (ok) {
      summary.totals.deletedFiles += 1;
      summary.totals.deletedBytes += o.size;
      console.log(`[PURGED] orphan reason=${o.reason} ${o.path} (${formatBytes(o.size)})`);
    } else {
      summary.totals.failures++;
    }
  } catch (e) {
    summary.totals.failures++;
    console.error(`[FAIL] delete orphan ${o.path}:`, e);
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

async function finish() {
  summary.finishedAt = new Date();
  summary.durationMs = summary.finishedAt.getTime() - summary.startedAt.getTime();
  console.log("==========================================================");
  console.log("[CLEANUP-JOB] Summary:");
  console.log(JSON.stringify(summary, null, 2));
  console.log("==========================================================");

  if (summary.totals.failures > 0 && !config.dryRun) {
    await sendAlert(
      `WARN: ${summary.totals.failures} failures`,
      `Cleanup-job completed with failures.\n\n${JSON.stringify(summary, null, 2)}`,
    );
  }

  await pool.end();
}

main()
  .then(() => {
    // Exit 0 hvis ferdig OK (også ved halt — det er ikke en feil, det er en bevisst stopp)
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("[FATAL]", err);
    await sendAlert("FATAL: cleanup-job crashed", String(err?.stack || err));
    try {
      await pool.end();
    } catch {}
    process.exit(1);
  });
