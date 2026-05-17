// SQL-queries for cleanup-kategorier 1-3 (DB-driven).
// Returnerer kandidat-rader fra event_images som skal purges.
//
// Alle queries filtrerer på files_purged_at IS NULL — vi rør ikke rader
// som allerede er markert som purged.
//
// graceDays er en parameter (default 30) som settes via env CLEANUP_GRACE_DAYS.

import { pool } from "./db.js";

export interface PurgeCandidate {
  id: string;
  event_id: string | null;
  image_url: string;
  file_extension: string | null;
  file_size: number | null;
  category: "archived" | "rejected" | "event_deleted";
  // Hvilket tidsstempel som trigget — for diagnose i dry-run-rapport
  trigger_at: Date;
}

// Kategori 1: Arkivert >graceDays dager
// LEFT JOIN events → skip bilder for inactive events (active=false).
// Hvis event er hard-slettet fra events-tabellen (e.event_id IS NULL),
// tillates sletting siden eventen ikke finnes lengre.
export async function findArchivedToPurge(graceDays: number): Promise<PurgeCandidate[]> {
  const sql = `
    SELECT ei.id, ei.event_id, ei.image_url, ei.file_extension, ei.file_size, ei.archived_at AS trigger_at
    FROM event_images ei
    LEFT JOIN events e ON e.event_id = ei.event_id
    WHERE ei.archived = true
      AND ei.archived_at IS NOT NULL
      AND ei.archived_at < NOW() - ($1::int || ' days')::interval
      AND ei.files_purged_at IS NULL
      AND (e.event_id IS NULL OR e.active IS DISTINCT FROM false)
    ORDER BY ei.archived_at ASC
  `;
  const r = await pool.query(sql, [graceDays]);
  return r.rows.map((row) => ({
    id: row.id,
    event_id: row.event_id,
    image_url: row.image_url,
    file_extension: row.file_extension,
    file_size: row.file_size == null ? null : Number(row.file_size),
    category: "archived" as const,
    trigger_at: new Date(row.trigger_at),
  }));
}

// Kategori 2: Moderering-avvist (rejected) >graceDays dager
// LEFT JOIN events → skip bilder for inactive events. Hard-deleted events (NULL JOIN)
// tillates siden eventen ikke finnes lenger.
export async function findRejectedToPurge(graceDays: number): Promise<PurgeCandidate[]> {
  const sql = `
    SELECT ei.id, ei.event_id, ei.image_url, ei.file_extension, ei.file_size, ei.moderated_at AS trigger_at
    FROM event_images ei
    LEFT JOIN events e ON e.event_id = ei.event_id
    WHERE ei.moderation_status = 'rejected'
      AND ei.moderated_at IS NOT NULL
      AND ei.moderated_at < NOW() - ($1::int || ' days')::interval
      AND ei.files_purged_at IS NULL
      AND (e.event_id IS NULL OR e.active IS DISTINCT FROM false)
    ORDER BY ei.moderated_at ASC
  `;
  const r = await pool.query(sql, [graceDays]);
  return r.rows.map((row) => ({
    id: row.id,
    event_id: row.event_id,
    image_url: row.image_url,
    file_extension: row.file_extension,
    file_size: row.file_size == null ? null : Number(row.file_size),
    category: "rejected" as const,
    trigger_at: new Date(row.trigger_at),
  }));
}

// Kategori 3: Tilhører event soft-slettet >graceDays dager
// Bruker JOIN: filtrer kun event_id (varchar) — events.event_id er nøkkel som
// event_images.event_id peker på (begge varchar(255)).
export async function findFromDeletedEventsToPurge(graceDays: number): Promise<PurgeCandidate[]> {
  const sql = `
    SELECT
      ei.id, ei.event_id, ei.image_url, ei.file_extension, ei.file_size,
      e.deleted_at AS trigger_at
    FROM event_images ei
    JOIN events e ON e.event_id = ei.event_id
    WHERE e.deleted_at IS NOT NULL
      AND e.deleted_at < NOW() - ($1::int || ' days')::interval
      AND ei.files_purged_at IS NULL
    ORDER BY e.deleted_at ASC
  `;
  const r = await pool.query(sql, [graceDays]);
  return r.rows.map((row) => ({
    id: row.id,
    event_id: row.event_id,
    image_url: row.image_url,
    file_extension: row.file_extension,
    file_size: row.file_size == null ? null : Number(row.file_size),
    category: "event_deleted" as const,
    trigger_at: new Date(row.trigger_at),
  }));
}

// Marker rader som purged etter at GCS-fil er slettet.
// Setter files_purged_at = NOW() — bevarer raden for historiske stats.
export async function markPurged(imageIds: string[]): Promise<number> {
  if (imageIds.length === 0) return 0;
  const sql = `
    UPDATE event_images
    SET files_purged_at = NOW()
    WHERE id = ANY($1::uuid[])
      AND files_purged_at IS NULL
  `;
  const r = await pool.query(sql, [imageIds]);
  return r.rowCount ?? 0;
}

// Hent referanse-sett for orphan-scan. Vi laster ALLE GCS-path-referanser fra DB
// til minne, så orphan-scanneren kan gjøre rask in-memory lookup mot bucket-listing.
// Set er typisk 10k-100k strings = lav MB-bruk.
export interface DbReferences {
  // GCS-paths referert av event_images.image_url (begge v1 og v2-paths inkludert).
  imagePaths: Set<string>;
  // GCS-paths referert av events.event_photo. Bevarer både aktive og soft-deleted
  // events innenfor grace-perioden (deleted_at IS NULL OR deleted_at > NOW() - graceDays).
  coverPaths: Set<string>;
  // mediaId-er (event_images.id) for v2-rader — brukt for derived/{ev}/{med}/-orphan-deteksjon.
  // Format: "eventId/mediaId"
  v2EventMediaPairs: Set<string>;
  // Event-IDs som er active=false. Orphan-scan skipper filer som tilhører disse
  // (parsed eventId fra path). Beskytter mot sletting av media i ikke-aktiverte
  // eller refunderte events.
  inactiveEventIds: Set<string>;
}

import { extractGcsPath } from "./gcs.js";

export async function loadDbReferences(graceDays: number): Promise<DbReferences> {
  const imagePaths = new Set<string>();
  const coverPaths = new Set<string>();
  const v2EventMediaPairs = new Set<string>();
  const inactiveEventIds = new Set<string>();

  // event_images.image_url — ta ALLE rader (også purged, så vi ikke re-prosesserer
  // filer som allerede er markert purged hvis GCS-sletting feilet sist).
  const imgResult = await pool.query<{ id: string; event_id: string | null; image_url: string }>(
    `SELECT id, event_id, image_url FROM event_images WHERE image_url IS NOT NULL`,
  );
  for (const row of imgResult.rows) {
    const path = extractGcsPath(row.image_url);
    if (path) imagePaths.add(path);

    // v2-detect: path matcher originals/{ev}/{med}.ext → registrer (ev, med)-par
    const v2 = path?.match(/^originals\/([^/]+)\/([^/]+)\.[^./]+$/);
    if (v2 && row.event_id) {
      v2EventMediaPairs.add(`${v2[1]}/${v2[2]}`);
    }
  }

  // events.event_photo — aktive eventer + de innenfor grace-perioden
  const evResult = await pool.query<{ event_photo: string | null }>(
    `SELECT event_photo FROM events
     WHERE event_photo IS NOT NULL
       AND (deleted_at IS NULL OR deleted_at > NOW() - ($1::int || ' days')::interval)`,
    [graceDays],
  );
  for (const row of evResult.rows) {
    const path = extractGcsPath(row.event_photo);
    if (path) coverPaths.add(path);
  }

  // events med active=false — orphan-scan skipper filer for disse event_ids
  const inactiveResult = await pool.query<{ event_id: string }>(
    `SELECT event_id FROM events WHERE active = false`,
  );
  for (const row of inactiveResult.rows) inactiveEventIds.add(row.event_id);

  console.log(
    `[DB-REFS] Loaded ${imagePaths.size} image paths, ${coverPaths.size} cover paths, ${v2EventMediaPairs.size} v2 event/media pairs, ${inactiveEventIds.size} inactive event_ids`,
  );

  return { imagePaths, coverPaths, v2EventMediaPairs, inactiveEventIds };
}
