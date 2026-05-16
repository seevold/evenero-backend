// Verifikasjons-modus: kryss orphan-kandidater mot events- og event_images-tabellene
// for å oppdage eventuelle falske positiver FØR vi skrur på live-deletion.
//
// Aktiveres med VERIFY_ORPHANS=true. Kjører etter orphan-scan, ingen sletting.
//
// Sjekker:
//   1. Event-eksistens: parser event_id fra path og sjekker events-tabellen.
//      Rapporterer fordeling: not_found / active / inactive / soft_deleted.
//   2. event_images cross-check: for et sample, sjekker om FILENAME (uten event-
//      prefiks/sequence/batch) finnes som substring i event_images.image_url,
//      title eller batch_id. Catcher tilfeller hvor klassifisering har bom-met
//      pga ukjent URL-format.
//   3. Cover-photo cross-check: sjekker om path-en figurerer i events.event_photo
//      direkte (også via LIKE) for et sample.

import { pool } from "./db.js";
import type { OrphanCandidate } from "./orphan-scan.js";

interface EventStatus {
  event_id: string;
  active: boolean | null;
  deleted_at: Date | null;
  event_date: string | null;
  event_name: string | null;
}

interface VerifyReport {
  totalOrphans: number;
  v1OrphansWithParsedEventId: number;
  uniqueEventIds: number;
  uniqueBatchIds: number;
  eventCategories: {
    not_in_events_table: number;
    active_event: number; // active=true, deleted_at IS NULL
    soft_deleted: number; // deleted_at IS NOT NULL
    inactive_event: number; // active=false, deleted_at IS NULL
  };
  // Batch-analyse: hvor mange orphans tilhører "batches som finnes i DB" vs "batches som ikke finnes"
  // Hvis batch-id IKKE finnes i DB i det hele tatt → hele batchen er ghost (failed upload eller hard-deleted event)
  // Hvis batch-id finnes med noen rader men ikke alle → split-batch (delvis failed upload)
  batchBreakdown: {
    orphans_in_ghost_batches: number; // batch helt fraværende i DB
    orphans_in_split_batches: number; // batch har noen rader men mangler denne
  };
  // Filer-per-event-fordeling — sjekker om noen event har MASSE orphans (typisk failed bulk-upload)
  topAffectedEvents: {
    event_id: string;
    orphan_count: number;
    eventExists: boolean;
    eventActive: boolean;
    eventSoftDeleted: boolean;
    db_image_count: number; // antall event_images-rader for samme event
  }[];
  riskySamples: {
    path: string;
    eventStatus: EventStatus | null;
    matchedInEventImages: number; // count of event_images rows where image_url ILIKE '%filename%'
    matchedInCoverPhoto: boolean;
  }[];
}

// v1-format: images/{eventId}__{batchId}__{seq}__{filename}.{ext}
// Vi parser ut eventId (første __-segment), batchId, og filename.
function parseV1Path(
  path: string,
): { eventId: string; batchId: string; filename: string } | null {
  const m = path.match(/^images\/([^_]+(?:_[^_]+)*?)__([^_]+(?:_[^_]+)*?)__(\d+)__(.+)$/);
  if (!m) return null;
  return { eventId: m[1], batchId: m[2], filename: m[4] };
}

// DEBUG: list image_url-formater for et sample event som "ble feilklassifisert".
// Hjelper å oppdage URL-format-varianter som extractGcsPath ikke håndterer.
export async function debugImageUrlFormatsForEvents(eventIds: string[]): Promise<void> {
  if (eventIds.length === 0) return;
  const r = await pool.query<{
    event_id: string;
    image_url: string;
    archived: boolean;
    files_purged_at: Date | null;
  }>(
    `SELECT event_id, image_url, archived, files_purged_at
     FROM event_images
     WHERE event_id = ANY($1::varchar[])
     ORDER BY event_id, uploaded_at DESC
     LIMIT 30`,
    [eventIds],
  );
  console.log("--- image_url format samples for risky events ---");
  for (const row of r.rows) {
    const url = row.image_url.length > 140 ? row.image_url.slice(0, 140) + "..." : row.image_url;
    console.log(`  event=${row.event_id} archived=${row.archived} purged=${!!row.files_purged_at}`);
    console.log(`    ${url}`);
  }
  console.log("---");
}

export async function verifyOrphans(orphans: OrphanCandidate[]): Promise<VerifyReport> {
  const report: VerifyReport = {
    totalOrphans: orphans.length,
    v1OrphansWithParsedEventId: 0,
    uniqueEventIds: 0,
    uniqueBatchIds: 0,
    eventCategories: {
      not_in_events_table: 0,
      active_event: 0,
      soft_deleted: 0,
      inactive_event: 0,
    },
    batchBreakdown: {
      orphans_in_ghost_batches: 0,
      orphans_in_split_batches: 0,
    },
    topAffectedEvents: [],
    riskySamples: [],
  };

  // ---- Phase 1: Parse event_ids + batch_ids ----
  const orphanByEventId = new Map<string, OrphanCandidate[]>();
  const orphanByBatchId = new Map<string, OrphanCandidate[]>();
  // (eventId, batchId) -> orphan-count
  for (const o of orphans) {
    if (o.reason !== "v1_image_no_db_row") continue;
    const parsed = parseV1Path(o.path);
    if (!parsed) continue;
    report.v1OrphansWithParsedEventId++;
    const arr = orphanByEventId.get(parsed.eventId) || [];
    arr.push(o);
    orphanByEventId.set(parsed.eventId, arr);
    const barr = orphanByBatchId.get(parsed.batchId) || [];
    barr.push(o);
    orphanByBatchId.set(parsed.batchId, barr);
  }

  const eventIds = Array.from(orphanByEventId.keys());
  const batchIds = Array.from(orphanByBatchId.keys());
  report.uniqueEventIds = eventIds.length;
  report.uniqueBatchIds = batchIds.length;

  if (eventIds.length === 0) {
    console.log("[VERIFY] No v1 orphans with parseable event_id — skipping.");
    return report;
  }

  // ---- Phase 2: Bulk-query events-tabellen ----
  const evResult = await pool.query<EventStatus>(
    `SELECT event_id, active, deleted_at, event_date::text AS event_date, event_name
     FROM events WHERE event_id = ANY($1::varchar[])`,
    [eventIds],
  );
  const eventsMap = new Map(evResult.rows.map((r) => [r.event_id, r]));

  for (const evId of eventIds) {
    const ev = eventsMap.get(evId);
    if (!ev) {
      report.eventCategories.not_in_events_table++;
      continue;
    }
    if (ev.deleted_at) {
      report.eventCategories.soft_deleted++;
      continue;
    }
    if (ev.active === false) {
      report.eventCategories.inactive_event++;
      continue;
    }
    // active = true OR null (default) + ikke soft-deleted
    report.eventCategories.active_event++;
  }

  // ---- Phase 2b: Batch-eksistens — finnes batch_id i DB i det hele tatt? ----
  // Vi sjekker om noen event_images-rad inneholder batch_id i image_url eller batch_id-kolonnen.
  // Hvis ja → "split batch" (noen filer i batchen ble registrert, denne ikke).
  // Hvis nei → "ghost batch" (hele batchen mangler i DB — failed upload eller hard-deleted event).
  const batchExistsInDb = new Map<string, boolean>();
  if (batchIds.length > 0) {
    // Sjekk via batch_id-kolonnen (mest pålitelig)
    const batchSeen = await pool.query<{ batch_id: string }>(
      `SELECT DISTINCT batch_id FROM event_images
       WHERE batch_id = ANY($1::varchar[])`,
      [batchIds],
    );
    for (const row of batchSeen.rows) batchExistsInDb.set(row.batch_id, true);
  }
  for (const [batchId, items] of orphanByBatchId.entries()) {
    if (batchExistsInDb.get(batchId)) {
      report.batchBreakdown.orphans_in_split_batches += items.length;
    } else {
      report.batchBreakdown.orphans_in_ghost_batches += items.length;
    }
  }

  // ---- Phase 2c: Top affected events ----
  // Hvilke eventer har flest orphans? Hjelper å se hvis det er én "katastrofe-event"
  // eller mange små lekkasjer. Også hent count av DB-rader per event for kontekst.
  const sortedEvents = [...orphanByEventId.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 15);

  if (sortedEvents.length > 0) {
    const topEventIds = sortedEvents.map(([id]) => id);
    const dbCounts = await pool.query<{ event_id: string; c: string }>(
      `SELECT event_id, COUNT(*)::text AS c FROM event_images
       WHERE event_id = ANY($1::varchar[])
       GROUP BY event_id`,
      [topEventIds],
    );
    const countMap = new Map(dbCounts.rows.map((r) => [r.event_id, Number(r.c)]));
    for (const [evId, items] of sortedEvents) {
      const ev = eventsMap.get(evId);
      report.topAffectedEvents.push({
        event_id: evId,
        orphan_count: items.length,
        eventExists: !!ev,
        eventActive: !!ev && !ev.deleted_at && ev.active !== false,
        eventSoftDeleted: !!ev?.deleted_at,
        db_image_count: countMap.get(evId) || 0,
      });
    }
  }

  // ---- Phase 3: Spot-check ----
  // Plukk 10 orphans hvor parsed event_id er i events-tabellen som ACTIVE
  // (høyest risiko for falsk positiv). Hvis ingen active: ta 10 fra soft-deleted.
  // Hvis ingen der heller: ta 10 random.
  const activeEventIds = eventIds.filter((id) => {
    const ev = eventsMap.get(id);
    return ev && !ev.deleted_at && ev.active !== false;
  });
  const softDeletedEventIds = eventIds.filter((id) => {
    const ev = eventsMap.get(id);
    return ev && ev.deleted_at;
  });

  const samplePool: OrphanCandidate[] = [];
  for (const id of activeEventIds.slice(0, 10)) {
    const arr = orphanByEventId.get(id);
    if (arr && arr[0]) samplePool.push(arr[0]);
  }
  if (samplePool.length < 10) {
    for (const id of softDeletedEventIds.slice(0, 10 - samplePool.length)) {
      const arr = orphanByEventId.get(id);
      if (arr && arr[0]) samplePool.push(arr[0]);
    }
  }
  if (samplePool.length < 5) {
    for (const o of orphans.slice(0, 10)) {
      if (samplePool.includes(o)) continue;
      samplePool.push(o);
      if (samplePool.length >= 10) break;
    }
  }

  for (const o of samplePool) {
    const parsed = parseV1Path(o.path);
    const eventStatus = parsed ? eventsMap.get(parsed.eventId) ?? null : null;

    // Cross-sjekk 1: event_images.image_url ILIKE '%filename%'
    // Fanger tilfeller hvor en aktiv rad har samme filnavn under annen path.
    let matchedInEventImages = 0;
    if (parsed) {
      const r = await pool.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM event_images
         WHERE image_url ILIKE $1 AND files_purged_at IS NULL`,
        [`%${parsed.filename}%`],
      );
      matchedInEventImages = Number(r.rows[0]?.c) || 0;
    }

    // Cross-sjekk 2: events.event_photo inneholder denne path-en (eller filnavnet)
    const r2 = await pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM events
       WHERE event_photo ILIKE $1
         AND (deleted_at IS NULL OR deleted_at > NOW() - INTERVAL '30 days')`,
      [`%${o.path.replace(/^images\//, "")}%`],
    );
    const matchedInCoverPhoto = (Number(r2.rows[0]?.c) || 0) > 0;

    report.riskySamples.push({
      path: o.path,
      eventStatus,
      matchedInEventImages,
      matchedInCoverPhoto,
    });
  }

  return report;
}

export function printVerifyReport(report: VerifyReport) {
  console.log("==========================================================");
  console.log("[VERIFY] Orphan classification cross-check");
  console.log("==========================================================");
  console.log(`Total orphans:                ${report.totalOrphans}`);
  console.log(`v1 orphans with parsed event: ${report.v1OrphansWithParsedEventId}`);
  console.log(`Unique event_ids referenced:  ${report.uniqueEventIds}`);
  console.log(`Unique batch_ids referenced:  ${report.uniqueBatchIds}`);
  console.log("");
  console.log("Event-category breakdown (for those unique event_ids):");
  console.log(`  not_in_events_table: ${report.eventCategories.not_in_events_table}  (event gone from DB — hard-deleted før soft-delete)`);
  console.log(`  active_event:        ${report.eventCategories.active_event}  (event aktivt — filer er ikke i kunde-galleri men event'et finnes)`);
  console.log(`  soft_deleted:        ${report.eventCategories.soft_deleted}  (event soft-slettet via UI)`);
  console.log(`  inactive_event:      ${report.eventCategories.inactive_event}  (active=false, ikke slettet)`);
  console.log("");
  console.log("Batch-eksistens-fordeling:");
  console.log(`  ghost_batches:  ${report.batchBreakdown.orphans_in_ghost_batches}  orphans i batches som IKKE finnes i DB → hele batchen er ghost (failed upload eller hard-deleted)`);
  console.log(`  split_batches:  ${report.batchBreakdown.orphans_in_split_batches}  orphans i batches der DB har noen, men ikke disse → delvis failed upload`);
  console.log("");
  console.log(`Top ${report.topAffectedEvents.length} affected events (event_id, orphan_count, event-status, DB image_count):`);
  for (const ev of report.topAffectedEvents) {
    const status = ev.eventExists
      ? ev.eventSoftDeleted
        ? "soft_deleted"
        : ev.eventActive
          ? "active"
          : "inactive"
      : "gone";
    console.log(`  ${ev.event_id}  orphans=${String(ev.orphan_count).padStart(5)}  event=${status.padEnd(13)}  db_images=${ev.db_image_count}`);
  }
  console.log("");
  console.log(`Spot-check (${report.riskySamples.length} samples — høyest risiko først):`);
  for (const s of report.riskySamples) {
    const status = s.eventStatus
      ? `event found: name="${s.eventStatus.event_name}" date=${s.eventStatus.event_date} active=${s.eventStatus.active} deleted_at=${s.eventStatus.deleted_at}`
      : "event NOT in events table";
    const flag = s.matchedInEventImages > 0 || s.matchedInCoverPhoto ? " 🚨" : "";
    console.log(`  ${s.path}${flag}`);
    console.log(`    ${status}`);
    console.log(`    matched filename in event_images: ${s.matchedInEventImages} rows`);
    console.log(`    matched in events.event_photo:    ${s.matchedInCoverPhoto}`);
  }
  console.log("==========================================================");
}
