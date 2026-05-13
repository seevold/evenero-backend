import { Storage } from '@google-cloud/storage';
import { randomBytes } from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { fileURLToPath } from 'url';
import archiver from 'archiver';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Google Cloud Storage configuration
const GCS_BUCKET_NAME = process.env.GCS_BUCKET_NAME || 'evenero-cloud';

let storage: Storage | null = null;

// Initialize Google Cloud Storage client
// På Cloud Run: bruker Application Default Credentials (ADC) — ingen private key.
// Lokalt: bruk `gcloud auth application-default login` eller sett GOOGLE_APPLICATION_CREDENTIALS til en SA-key-fil.
export function initGoogleCloudStorage() {
  try {
    storage = new Storage({
      projectId: process.env.GCP_PROJECT_ID || "evenero",
    });
    console.log(`[GCS] Initialized with ADC, bucket=${GCS_BUCKET_NAME}`);
    return storage;
  } catch (error) {
    console.error("[GCS] Failed to initialize:", error);
    return null;
  }
}

// Generate a signed URL for file upload using v2 path-konvensjon
//
// v2 path-konvensjon: originals/{eventId}/{mediaId}.{ext}
// → utløser Pub/Sub-trigger til image-processor-v2 / video-processor-v2
// → genererer derived/{eventId}/{mediaId}/{thumb,medium,poster,preview}.*
//
// mediaId genereres her (UUID) og returneres i respons. Klienten må
// bruke denne mediaId-en som event_images.id ved metadata-registrering,
// slik at gallery-frontend kan bygge derived-paths fra mediaId og
// vise poster/medium uten å laste video/full bilde.
//
// batchId og sequence er beholdt i parameter-signaturen for
// bakoverkompatibilitet med eldre callers, men brukes ikke lenger i
// path-en (v2 trenger dem ikke).
export async function generateUploadUrl(
  eventId: string,
  batchId: string,
  sequence: number,
  filename: string,
  contentType: string
): Promise<{ url: string; publicUrl: string; mediaId: string } | null> {
  if (!storage) {
    console.error('Google Cloud Storage not initialized');
    return null;
  }

  try {
    const bucket = storage.bucket(GCS_BUCKET_NAME);

    // Generer mediaId som UUID — matcher event_images.id-format og er
    // unikt per opplasting. Vi bruker crypto.randomUUID() (Node 14.17+)
    // i stedet for nanoid for å unngå ny dependency.
    const { randomUUID } = await import('crypto');
    const mediaId = randomUUID();

    const ext = path.extname(filename); // includes leading dot
    const gcsFilename = `originals/${eventId}/${mediaId}${ext}`;

    const file = bucket.file(gcsFilename);

    // Signed URL for upload — gyldig i 3 timer (event-WiFi, mobile data,
    // multi-GB videoer kan ta tid).
    const [url] = await file.getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: Date.now() + 3 * 60 * 60 * 1000,
      contentType,
    });

    const publicUrl = `https://storage.googleapis.com/${GCS_BUCKET_NAME}/${gcsFilename}`;

    return { url, publicUrl, mediaId };
  } catch (error) {
    console.error('Error generating upload URL:', error);
    return null;
  }
}

// Upload file directly to Google Cloud Storage (for server-side uploads like QR codes)
export async function uploadToGoogleCloudStorage(
  localFilePath: string,
  destinationPath: string,
  makePublic: boolean = false
): Promise<string | null> {
  if (!storage) {
    console.error('Google Cloud Storage not initialized');
    return null;
  }

  try {
    const bucket = storage.bucket(GCS_BUCKET_NAME);
    const file = bucket.file(destinationPath);
    
    // Upload the file
    await bucket.upload(localFilePath, {
      destination: destinationPath,
      metadata: {
        cacheControl: 'public, max-age=31536000', // Cache for 1 year
      }
    });
    
    // Make the file public if requested
    if (makePublic) {
      await file.makePublic();
      return file.publicUrl();
    }
    
    return `gs://${GCS_BUCKET_NAME}/${destinationPath}`;
  } catch (error) {
    console.error('Error uploading to Google Cloud Storage:', error);
    return null;
  }
}

// Generate QR code and upload to Google Cloud Storage
export async function generateAndUploadQRCode(eventId: string): Promise<boolean> {
  // This would require the 'qrcode' or 'segno' equivalent library in Node.js
  // For now, we'll return true as a placeholder
  // TODO: Implement QR code generation
  console.log(`QR code generation for event ${eventId} - TODO`);
  return true;
}

// List files in a bucket (useful for management)
export async function listFiles(prefix?: string): Promise<string[]> {
  if (!storage) {
    console.error('Google Cloud Storage not initialized');
    return [];
  }

  try {
    const bucket = storage.bucket(GCS_BUCKET_NAME);
    const [files] = await bucket.getFiles({ prefix });
    return files.map(file => file.name);
  } catch (error) {
    console.error('Error listing files:', error);
    return [];
  }
}

// Delete a file from Google Cloud Storage. Idempotent — 404 (allerede slettet)
// teller som suksess for å unngå å fail'e cascade-slett ved partielle tilstander.
export async function deleteFile(filename: string): Promise<boolean> {
  if (!storage) {
    console.error("[GCS] Not initialized");
    return false;
  }

  try {
    const bucket = storage.bucket(GCS_BUCKET_NAME);
    await bucket.file(filename).delete();
    console.log(`[GCS] Deleted: ${filename}`);
    return true;
  } catch (error: any) {
    if (error?.code === 404) {
      // Allerede slettet eller eksisterte aldri — idempotent suksess
      console.log(`[GCS] Already gone (404): ${filename}`);
      return true;
    }
    console.error(`[GCS] Failed to delete ${filename}:`, error?.message || error);
    return false;
  }
}

// Slett alle filer som matcher et prefix (f.eks. "derived/{ev}/{med}/").
// Returnerer antall slettede filer. Idempotent: tom mappe gir 0.
export async function deletePrefix(prefix: string): Promise<number> {
  if (!storage) {
    console.error("[GCS] Not initialized");
    return 0;
  }
  try {
    const bucket = storage.bucket(GCS_BUCKET_NAME);
    const [files] = await bucket.getFiles({ prefix });
    if (files.length === 0) return 0;
    await Promise.all(files.map((f) => f.delete({ ignoreNotFound: true } as any)));
    console.log(`[GCS] Deleted ${files.length} files under prefix: ${prefix}`);
    return files.length;
  } catch (error: any) {
    console.error(`[GCS] Failed to delete prefix ${prefix}:`, error?.message || error);
    return 0;
  }
}

// Extract GCS-path fra full URL eller gs://-URI.
// Eksempel-input:
//   https://storage.googleapis.com/evenero-cloud/images/abc.jpg?token=xyz
//   gs://evenero-staging-cloud/images/abc.jpg
// Returnerer: "images/abc.jpg" (path uten bucket eller query-params)
// Returnerer null hvis URL ikke matcher GCS-format.
//
// Logger advarsel hvis URL'en peker til en annen bucket enn GCS_BUCKET_NAME
// (kan skje ved migrering — sletting vil da treffe feil bucket og må fikses manuelt).
export function extractGcsPath(url: string | null | undefined): string | null {
  if (!url || typeof url !== "string") return null;

  // https://storage.googleapis.com/<bucket>/<path>
  const httpsMatch = url.match(/^https?:\/\/storage\.googleapis\.com\/([^/]+)\/(.+?)(?:\?|$)/);
  if (httpsMatch) {
    const [, bucket, path] = httpsMatch;
    if (bucket !== GCS_BUCKET_NAME) {
      console.warn(
        `[GCS] URL refererer bucket '${bucket}' men GCS_BUCKET_NAME='${GCS_BUCKET_NAME}' — sletting vil treffe feil bucket. Skipping.`,
      );
      return null;
    }
    return decodeURIComponent(path);
  }

  // gs://<bucket>/<path>
  const gsMatch = url.match(/^gs:\/\/([^/]+)\/(.+)$/);
  if (gsMatch) {
    const [, bucket, path] = gsMatch;
    if (bucket !== GCS_BUCKET_NAME) {
      console.warn(`[GCS] gs:// refererer '${bucket}' ulik GCS_BUCKET_NAME='${GCS_BUCKET_NAME}'. Skipping.`);
      return null;
    }
    return path;
  }

  return null;
}

// Generér derivative-path basert på fil-extension.
// Bilder: <name>.<ext> → <name>_small.<ext>
// Videoer: <name>.<ext> → <name>_compressed.<ext>
const VIDEO_EXTS = ["mp4", "mov", "avi", "wmv", "webm", "mkv"];
export function getDerivativePath(originalPath: string): string {
  const lastDot = originalPath.lastIndexOf(".");
  const ext = lastDot > 0 ? originalPath.slice(lastDot + 1).toLowerCase() : "";
  const isVideo = VIDEO_EXTS.includes(ext);
  const suffix = isVideo ? "_compressed" : "_small";
  if (lastDot < 0) return originalPath + suffix;
  return originalPath.slice(0, lastDot) + suffix + originalPath.slice(lastDot);
}

// Slett fil basert på URL — slår sammen extractGcsPath + deleteFile.
// Idempotent. Returnerer true hvis slettet eller allerede borte; false ved ekte feil.
export async function deleteFileByUrl(url: string | null | undefined): Promise<boolean> {
  const path = extractGcsPath(url);
  if (!path) {
    if (url) console.warn(`[GCS] Kunne ikke parse URL for sletting: ${url.substring(0, 100)}`);
    return false;
  }
  return deleteFile(path);
}

// Extract filename from GCS URL
function getFilenameFromUrl(url: string): string {
  // Example: "https://storage.googleapis.com/evenero-cloud/images/bznfb9__HOING__1__1000002891.jpg"
  // Returns: "bznfb9__HOING__1__1000002891.jpg"
  return url.split('/').pop() || 'image.jpg';
}

// Create zip file from images and upload to GCS using streaming
export async function createZipFromImages(imageUrls: string[]): Promise<string | null> {
  if (!storage) {
    console.error('Google Cloud Storage not initialized');
    return null;
  }

  if (imageUrls.length === 0) {
    console.error('No image URLs provided');
    return null;
  }

  try {
    const bucket = storage.bucket(GCS_BUCKET_NAME);
    
    // Generate unique filename for the zip
    const uniqueSuffix = randomBytes(8).toString('hex');
    const zipFilename = `images_${uniqueSuffix}.zip`;
    const zipGcsPath = `zip/${zipFilename}`;
    
    // Create GCS file for writing the zip
    const zipFile = bucket.file(zipGcsPath);
    const zipWriteStream = zipFile.createWriteStream({
      metadata: {
        contentType: 'application/zip',
      },
      resumable: true, // Required for large files (>5 MB)
      chunkSize: 5 * 1024 * 1024, // 5 MB chunks for resumable upload
    });

    // Create archiver instance
    const archive = archiver('zip', {
      zlib: { level: 6 }, // Compression level (0-9, 6 is default)
      forceZip64: true, // Required for archives >4 GB
    });

    // Pipe archive directly to GCS (no local storage needed!)
    archive.pipe(zipWriteStream);

    // Track success/failure
    let successCount = 0;
    let failureCount = 0;

    // Add each image to the zip by streaming
    for (const imageUrl of imageUrls) {
      try {
        const filename = getFilenameFromUrl(imageUrl);
        const gcsFilename = `images/${filename}`;
        const file = bucket.file(gcsFilename);
        
        // Check if file exists
        const [exists] = await file.exists();
        if (!exists) {
          console.warn(`File not found: ${gcsFilename}`);
          failureCount++;
          continue;
        }

        // Stream the image directly from GCS into the zip
        const readStream = file.createReadStream();
        
        // Add to zip with unique name to avoid conflicts
        const uniqueId = randomBytes(4).toString('hex');
        const ext = path.extname(filename);
        const zipEntryName = `${uniqueId}${ext}`;
        
        archive.append(readStream, { name: zipEntryName });
        successCount++;
        
        console.log(`Streaming ${filename} into zip as ${zipEntryName}`);
      } catch (error) {
        console.error(`Error adding image ${imageUrl} to zip:`, error);
        failureCount++;
      }
    }

    // Check if we added any files
    if (successCount === 0) {
      console.error('Failed to add any images to zip');
      archive.abort();
      
      // Clean up: destroy write stream and delete stub object
      zipWriteStream.destroy();
      try {
        await zipFile.delete();
      } catch (error) {
        console.error('Error deleting stub zip file:', error);
      }
      
      return null;
    }

    console.log(`Zip creation: ${successCount} succeeded, ${failureCount} failed`);

    // Set up completion promise BEFORE finalizing to avoid race condition
    const uploadComplete = new Promise<void>((resolve, reject) => {
      zipWriteStream.on('finish', () => {
        console.log(`Zip file uploaded to GCS: ${zipGcsPath}, size: ${archive.pointer()} bytes`);
        resolve();
      });
      zipWriteStream.on('error', reject);
      archive.on('error', reject);
    });

    // Finalize the archive (no more files will be added)
    await archive.finalize();

    // Wait for the upload to GCS to complete
    await uploadComplete;

    // Generate signed URL (15 minutes expiry)
    const [signedUrl] = await zipFile.getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + 15 * 60 * 1000, // 15 minutes
    });

    return signedUrl;
  } catch (error) {
    console.error('Error creating zip file:', error);
    return null;
  }
}