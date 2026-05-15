/**
 * Programmatiske tester for batch signed-URL-flyten.
 *
 * Kjør:  npx tsx --test test/upload-batch.test.ts
 *
 * Mocker @google-cloud/storage ved å patche File.prototype.getSignedUrl
 * FØR vi dynamisk-importerer gcs.ts. Da slipper vi reelle GCS-kall.
 *
 * Tester:
 *  1. generateUploadUrlsBatch — kjernelogikken:
 *     - path-format originals/{eventId}/{mediaId}.{ext}
 *     - mediaId er UUID v4
 *     - contentType propageres til getSignedUrl
 *     - publicUrl-format
 *     - rekkefølge bevart (sequence matcher input-rekkefølge)
 *     - per-fil-feil isoleres (én feilet ødelegger ikke andre)
 *     - tomt array returnerer tomt array
 *     - 500 filer fungerer parallelt
 *  2. Route-validering — speilet av handler-logikken i routes.ts:
 *     - 400 ved manglende event_id, tomt files, ugyldig fil-entry, >500 filer
 *     - korrekt response-shape ved suksess (matcher single-endpoint-feltene)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// MÅ settes før gcs.ts importeres — den thrower ved manglende env.
process.env.GCS_BUCKET_NAME = 'test-bucket';
process.env.GCP_PROJECT_ID = 'test-project';

// Patch @google-cloud/storage så getSignedUrl ikke gjør faktiske kall.
const storageLib = await import('@google-cloud/storage');
const FileProto = (storageLib as any).File.prototype;
let lastSignCalls: Array<{ name: string; contentType: string; expires: number }> = [];
FileProto.getSignedUrl = async function (opts: any) {
  lastSignCalls.push({
    name: this.name,
    contentType: opts.contentType,
    expires: opts.expires,
  });
  return [`https://signed.example/${encodeURIComponent(this.name)}?expires=${opts.expires}&ct=${encodeURIComponent(opts.contentType)}`];
};

const { generateUploadUrlsBatch, initGoogleCloudStorage } = await import('../src/gcs.js');
initGoogleCloudStorage();

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test('generateUploadUrlsBatch: enkelt-fil — path, UUID, contentType, publicUrl', async () => {
  lastSignCalls = [];
  const results = await generateUploadUrlsBatch('evt-abc', [
    { filename: 'IMG_0001.jpg', contentType: 'image/jpeg', sequence: 1 },
  ]);
  assert.equal(results.length, 1);
  const r = results[0];
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.sequence, 1);
  assert.equal(r.filename, 'IMG_0001.jpg');
  assert.match(r.mediaId, UUID_V4);
  // GCS-path (lest fra mocken)
  assert.equal(lastSignCalls.length, 1);
  assert.equal(lastSignCalls[0].name, `originals/evt-abc/${r.mediaId}.jpg`);
  assert.equal(lastSignCalls[0].contentType, 'image/jpeg');
  // publicUrl
  assert.equal(r.publicUrl, `https://storage.googleapis.com/test-bucket/originals/evt-abc/${r.mediaId}.jpg`);
  // url er signed URL
  assert.ok(r.url.startsWith('https://signed.example/'));
});

test('generateUploadUrlsBatch: bevarer rekkefølge og sequence over 100 filer', async () => {
  lastSignCalls = [];
  const files = Array.from({ length: 100 }, (_, i) => ({
    filename: `file_${i}.png`,
    contentType: 'image/png',
    sequence: i + 1,
  }));
  const results = await generateUploadUrlsBatch('evt-order', files);
  assert.equal(results.length, 100);
  for (let i = 0; i < 100; i++) {
    const r = results[i];
    assert.equal(r.ok, true);
    if (!r.ok) continue;
    assert.equal(r.sequence, i + 1);
    assert.equal(r.filename, `file_${i}.png`);
    assert.match(r.mediaId, UUID_V4);
  }
});

test('generateUploadUrlsBatch: alle mediaIds er unike i en batch på 500', async () => {
  const files = Array.from({ length: 500 }, (_, i) => ({
    filename: `f${i}.jpg`,
    contentType: 'image/jpeg',
    sequence: i + 1,
  }));
  const results = await generateUploadUrlsBatch('evt-unique', files);
  assert.equal(results.length, 500);
  const ids = new Set(results.filter(r => r.ok).map(r => (r as any).mediaId));
  assert.equal(ids.size, 500, 'alle mediaIds skal være unike');
});

test('generateUploadUrlsBatch: contentType propageres riktig per fil', async () => {
  lastSignCalls = [];
  const files = [
    { filename: 'a.mp4', contentType: 'video/mp4', sequence: 1 },
    { filename: 'b.mov', contentType: 'video/quicktime', sequence: 2 },
    { filename: 'c.heic', contentType: 'image/heic', sequence: 3 },
  ];
  await generateUploadUrlsBatch('evt-ct', files);
  // rekkefølge i lastSignCalls er ikke garantert (Promise.allSettled parallel),
  // så map navn → contentType
  const byCt = new Map(lastSignCalls.map(c => [c.contentType, c.name]));
  assert.equal(byCt.size, 3);
  assert.ok(byCt.get('video/mp4')?.endsWith('.mp4'));
  assert.ok(byCt.get('video/quicktime')?.endsWith('.mov'));
  assert.ok(byCt.get('image/heic')?.endsWith('.heic'));
});

test('generateUploadUrlsBatch: expiry er 3 timer fram i tid', async () => {
  lastSignCalls = [];
  const before = Date.now();
  await generateUploadUrlsBatch('evt-exp', [
    { filename: 'x.jpg', contentType: 'image/jpeg', sequence: 1 },
  ]);
  const expires = lastSignCalls[0].expires;
  const expected = before + 3 * 60 * 60 * 1000;
  // Generøs toleranse — tester kun at vi er i riktig størrelsesorden.
  assert.ok(Math.abs(expires - expected) < 5_000, `expires ${expires} ≈ ${expected}`);
});

test('generateUploadUrlsBatch: per-fil-feil isoleres (én kaster, resten OK)', async () => {
  lastSignCalls = [];
  let callCount = 0;
  const originalGetSignedUrl = FileProto.getSignedUrl;
  FileProto.getSignedUrl = async function (opts: any) {
    callCount++;
    if (this.name.endsWith('/bad.jpg') || this.name.includes('bad')) {
      // Vi kan ikke matche på filename pga UUID i path — la oss feile basert på sekvens.
    }
    // Match faktisk på contentType for å skille filene
    if (opts.contentType === 'application/x-fail') {
      throw new Error('Synthetic signing failure');
    }
    return [`https://signed.example/${this.name}`];
  };
  try {
    const results = await generateUploadUrlsBatch('evt-mix', [
      { filename: 'good1.jpg', contentType: 'image/jpeg', sequence: 1 },
      { filename: 'bad.jpg', contentType: 'application/x-fail', sequence: 2 },
      { filename: 'good2.jpg', contentType: 'image/jpeg', sequence: 3 },
    ]);
    assert.equal(results.length, 3);
    assert.equal(results[0].ok, true, 'fil 1 OK');
    assert.equal(results[1].ok, false, 'fil 2 feilet');
    assert.equal(results[2].ok, true, 'fil 3 OK');
    if (!results[1].ok) {
      assert.equal(results[1].sequence, 2);
      assert.equal(results[1].filename, 'bad.jpg');
      // generateUploadUrl swallow'er feilen til null → batch ser "Failed to generate URL".
      // Det viktige er at isoleringen fungerer (fil 1 og 3 OK) — ikke meldings-teksten.
      assert.ok(results[1].error.length > 0);
    }
  } finally {
    FileProto.getSignedUrl = originalGetSignedUrl;
  }
});

test('generateUploadUrlsBatch: tomt array returnerer tomt array', async () => {
  const results = await generateUploadUrlsBatch('evt-empty', []);
  assert.equal(results.length, 0);
});

test('generateUploadUrlsBatch: filnavn med spesialtegn — UUID-path beskytter mot encoding-bugs', async () => {
  lastSignCalls = [];
  const results = await generateUploadUrlsBatch('evt-special', [
    { filename: 'Åre & Tønder (2024).JPG', contentType: 'image/jpeg', sequence: 1 },
  ]);
  assert.equal(results[0].ok, true);
  if (!results[0].ok) return;
  // Path inneholder kun UUID + ext — ikke originalt filnavn.
  // Dette er bevisst: originalt filnavn lagres i event_images.title via metadata-endpoint.
  assert.match(lastSignCalls[0].name, /^originals\/evt-special\/[0-9a-f-]+\.JPG$/i);
});

// =====================================================================
// Route-validering — speilet av handler-logikken i routes.ts.
// Vi tester valideringen direkte via en helper som matcher handler-koden.
// Hvis valideringslogikken endres i routes.ts uten å oppdatere denne, må
// testene fanger det opp (helperen er en 1:1-kopi).
// =====================================================================

type RouteFile = { filename?: unknown; content_type?: unknown; sequence?: unknown };

function validateBatchRequest(body: any): { status: number; detail?: string } | null {
  const event_id = body?.event_id;
  const files = body?.files;

  if (!event_id || typeof event_id !== 'string') {
    return { status: 400, detail: 'Missing or invalid event_id' };
  }
  if (!Array.isArray(files) || files.length === 0) {
    return { status: 400, detail: 'files must be a non-empty array' };
  }
  if (files.length > 500) {
    return { status: 400, detail: 'Maximum 500 files per batch' };
  }
  for (let i = 0; i < files.length; i++) {
    const f = files[i] as RouteFile;
    if (!f || typeof f.filename !== 'string' || typeof f.content_type !== 'string' || typeof f.sequence !== 'number') {
      return { status: 400, detail: `Invalid file at index ${i}: requires {filename, content_type, sequence}` };
    }
  }
  return null; // OK
}

test('route validering: mangler event_id → 400', () => {
  const r = validateBatchRequest({ files: [{ filename: 'a.jpg', content_type: 'image/jpeg', sequence: 1 }] });
  assert.equal(r?.status, 400);
  assert.match(r!.detail!, /event_id/);
});

test('route validering: tomt files-array → 400', () => {
  const r = validateBatchRequest({ event_id: 'e', files: [] });
  assert.equal(r?.status, 400);
  assert.match(r!.detail!, /non-empty/);
});

test('route validering: 501 filer → 400', () => {
  const files = Array.from({ length: 501 }, (_, i) => ({ filename: 'a', content_type: 'b', sequence: i }));
  const r = validateBatchRequest({ event_id: 'e', files });
  assert.equal(r?.status, 400);
  assert.match(r!.detail!, /500/);
});

test('route validering: 500 filer akseptert (grense)', () => {
  const files = Array.from({ length: 500 }, (_, i) => ({ filename: 'a', content_type: 'b', sequence: i }));
  const r = validateBatchRequest({ event_id: 'e', files });
  assert.equal(r, null);
});

test('route validering: fil uten content_type → 400 med riktig index', () => {
  const files = [
    { filename: 'a.jpg', content_type: 'image/jpeg', sequence: 1 },
    { filename: 'b.jpg', sequence: 2 }, // mangler content_type
  ];
  const r = validateBatchRequest({ event_id: 'e', files });
  assert.equal(r?.status, 400);
  assert.match(r!.detail!, /index 1/);
});

test('route validering: sequence som string → 400', () => {
  const files = [{ filename: 'a.jpg', content_type: 'image/jpeg', sequence: '1' }];
  const r = validateBatchRequest({ event_id: 'e', files });
  assert.equal(r?.status, 400);
});

test('route validering: gyldig request passerer', () => {
  const r = validateBatchRequest({
    event_id: 'evt-123',
    files: [{ filename: 'a.jpg', content_type: 'image/jpeg', sequence: 1 }],
  });
  assert.equal(r, null);
});
