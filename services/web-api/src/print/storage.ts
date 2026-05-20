// GCS-helper for opplasting av print-PDFer.
//
// PDF-er må være offentlig lesbare av Gelato (de henter via URL). Vi laster
// til public-folder `print/` i bucket og returnerer signed URL med 7-dagers
// utløp — lang nok til at Gelato får hentet, kort nok at vi ikke etterlater
// kunde-data evig tilgjengelig.

import { Storage } from "@google-cloud/storage";

if (!process.env.GCS_BUCKET_NAME) {
  throw new Error(
    "GCS_BUCKET_NAME er ikke satt. Per Cloud Run-service: " +
    "prod=evenero-cloud, staging=evenero-staging-cloud.",
  );
}
const BUCKET_NAME = process.env.GCS_BUCKET_NAME;

let storage: Storage | null = null;
function getStorage(): Storage {
  if (!storage) {
    storage = new Storage({ projectId: process.env.GCP_PROJECT_ID || "evenero" });
  }
  return storage;
}

export interface UploadedPdf {
  /** URL Gelato kan hente PDF fra (signed, 7d expiry). */
  url: string;
  /** Path i bucket — lagres i print_order_items for debugging/cleanup. */
  bucketPath: string;
}

/** Last opp en PDF-buffer til print/{orderId}/{itemId}.pdf. */
export async function uploadPrintPdf(
  orderId: string,
  itemId: string,
  pdf: Buffer,
): Promise<UploadedPdf> {
  const bucketPath = `print/${orderId}/${itemId}.pdf`;
  const file = getStorage().bucket(BUCKET_NAME).file(bucketPath);
  await file.save(pdf, {
    contentType: "application/pdf",
    resumable: false,
    metadata: { cacheControl: "private, max-age=604800" },
  });

  // Signed URL — 7 dager. Gelato henter typisk innen 30 sek etter ordre-opprettelse.
  const [url] = await file.getSignedUrl({
    version: "v4",
    action: "read",
    expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
  });
  return { url, bucketPath };
}

/** Last opp kundens design-PNG (fra data-URL) som print-fil.
 *  Brukes når kunden har et eget design — Gelato godtar PNG direkte. */
export async function uploadDesignImage(
  orderId: string,
  itemId: string,
  dataUrl: string,
): Promise<UploadedPdf> {
  // data-URL: "data:image/png;base64,XXXX"
  const match = dataUrl.match(/^data:image\/(png|jpeg);base64,(.+)$/);
  if (!match) throw new Error("Ugyldig design data-URL (forventet PNG/JPEG base64)");
  const ext = match[1] === "jpeg" ? "jpg" : "png";
  const buffer = Buffer.from(match[2], "base64");
  if (buffer.length > 15 * 1024 * 1024) {
    throw new Error("Design-bilde for stort (maks 15 MB)");
  }
  const bucketPath = `print/${orderId}/${itemId}-design.${ext}`;
  const file = getStorage().bucket(BUCKET_NAME).file(bucketPath);
  await file.save(buffer, {
    contentType: `image/${match[1]}`,
    resumable: false,
    metadata: { cacheControl: "private, max-age=604800" },
  });
  const [url] = await file.getSignedUrl({
    version: "v4", action: "read",
    expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
  });
  return { url, bucketPath };
}

/** Resultat av design-validering. */
export interface DesignValidation {
  ok: boolean;
  reason?: string;
  widthBytes?: number;
}

/** Valider en design-data-URL (PNG/JPEG, fornuftig størrelse). */
export function validateDesignDataUrl(dataUrl: string): DesignValidation {
  const match = dataUrl.match(/^data:image\/(png|jpeg);base64,(.+)$/);
  if (!match) return { ok: false, reason: "Ikke en gyldig PNG/JPEG data-URL" };
  let buffer: Buffer;
  try {
    buffer = Buffer.from(match[2], "base64");
  } catch {
    return { ok: false, reason: "Base64-dekoding feilet" };
  }
  if (buffer.length < 5_000) {
    return { ok: false, reason: "Bilde mistenkelig lite (< 5 KB) — sannsynlig tomt" };
  }
  if (buffer.length > 25 * 1024 * 1024) {
    return { ok: false, reason: "Bilde for stort (> 25 MB)" };
  }
  // PNG-magic: 89 50 4E 47 · JPEG-magic: FF D8 FF
  const isPng = buffer[0] === 0x89 && buffer[1] === 0x50;
  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8;
  if (!isPng && !isJpeg) {
    return { ok: false, reason: "Fil-header er ikke PNG/JPEG" };
  }
  return { ok: true, widthBytes: buffer.length };
}

/** Last opp et pre-order design (ved "Tilpass og bestill"). designToken er
 *  en uuid generert av backend; brukes som stabil referanse til filen. */
export async function uploadPreorderDesign(
  designToken: string,
  dataUrl: string,
): Promise<UploadedPdf> {
  const v = validateDesignDataUrl(dataUrl);
  if (!v.ok) throw new Error(`Ugyldig design: ${v.reason}`);
  const match = dataUrl.match(/^data:image\/(png|jpeg);base64,(.+)$/)!;
  const ext = match[1] === "jpeg" ? "jpg" : "png";
  const buffer = Buffer.from(match[2], "base64");
  const bucketPath = `print/preorder/${designToken}.${ext}`;
  const file = getStorage().bucket(BUCKET_NAME).file(bucketPath);
  await file.save(buffer, {
    contentType: `image/${match[1]}`,
    resumable: false,
    metadata: { cacheControl: "private, max-age=604800" },
  });
  const [url] = await file.getSignedUrl({
    version: "v4", action: "read",
    expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
  });
  return { url, bucketPath };
}

/** Sjekk at en URL faktisk peker på en hentbar, gyldig bilde-fil.
 *  Brukes som pre-Gelato-vakt — vi sender aldri en død/tom URL til print. */
export async function verifyDesignUrlReachable(url: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15_000);
    const res = await fetch(url, { method: "GET", signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 5_000) return false;
    const isPng = buf[0] === 0x89 && buf[1] === 0x50;
    const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
    return isPng || isJpeg;
  } catch {
    return false;
  }
}

/** Sletter PDF-en (eks. ved refund eller cleanup). Stille-feilende. */
export async function deletePrintPdf(bucketPath: string): Promise<void> {
  try {
    await getStorage().bucket(BUCKET_NAME).file(bucketPath).delete();
  } catch (err) {
    console.warn(`[print/storage] Kunne ikke slette ${bucketPath}:`, (err as Error).message);
  }
}
