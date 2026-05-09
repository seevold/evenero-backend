# video-processor

Cloud Run-tjeneste som genererer streaming-vennlig MP4 + JPEG-poster fra opplastede videoer.

**Trigger:** GCS object finalize på `evenero-staging-cloud` (prefix `originals/`) → Pub/Sub topic `media-uploaded` → push subscription `video-processor-sub` (delt topic m/ image-processor; hver subscriber filtrerer på `contentType` i app-koden).

**Path-konvensjon:**
```
input:  {bucket}/originals/{eventId}/{mediaId}.{ext}
output: {bucket}/derived/{eventId}/{mediaId}/preview.mp4
        {bucket}/derived/{eventId}/{mediaId}/poster.jpg
```

## Smart-skip

`ffprobe` kjøres først. Hvis source allerede er web-friendly:
- Codec = h264
- Width ≤ 1280
- Bitrate ≤ 4.5 Mbps

→ kun **remux** med `+faststart` (1–3 sek). Ellers fullt re-encode.

## Re-encode-parametre

```
-c:v libx264 -preset veryfast -crf 24
-profile:v high -level 4.1 -pix_fmt yuv420p
-vf scale='min(1280,iw)':-2
-maxrate 4M -bufsize 8M
-c:a aac -b:a 128k -ac 2
-movflags +faststart
```

Universal H.264 (iOS Safari OK), 720p maks bredde, jevn bitrate for mobilnett.

## Cloud Run-konfig (deploy-anbefaling)

```bash
gcloud run deploy video-processor-v2 \
  --source . \
  --region europe-north1 --project evenero \
  --no-allow-unauthenticated \
  --set-env-vars GCS_BUCKET_NAME=evenero-staging-cloud \
  --service-account staging-runner@evenero.iam.gserviceaccount.com \
  --memory 4Gi --cpu 4 --concurrency 1 \
  --max-instances 10 --min-instances 0 --timeout 3600s
```

`concurrency=1` fordi ffmpeg bruker alle vCPU. `timeout=3600s` for store videoer.

## Konfig (env-vars)

| Var | Default | Beskrivelse |
|---|---|---|
| `GCS_BUCKET_NAME` | (required) | Bucket for input + output |
| `INPUT_PREFIX` | `originals` | |
| `OUTPUT_PREFIX` | `derived` | |
| `MAX_WIDTH` | `1280` | Re-encode scale cap |
| `CRF` | `24` | x264 quality (lavere = bedre/større) |
| `PRESET` | `veryfast` | x264 speed/size tradeoff |
| `MAX_RATE` | `4M` | bitrate cap |
| `BUF_SIZE` | `8M` | rate buffer |
| `AUDIO_BITRATE` | `128k` | AAC |
| `SKIP_MAX_WIDTH` | `1280` | Smart-skip cap (width) |
| `SKIP_MAX_BITRATE` | `4500000` | Smart-skip cap (bps) |
| `SKIP_CODECS` | `h264` | Comma-list av codecs som triggeres remux |
| `MAX_INPUT_BYTES` | `5368709120` | 5 GB hard cap |
| `POSTER_TIMESTAMP` | `00:00:01` | Når posteren grippes |
| `POSTER_WIDTH` | `400` | Poster-bredde |

## Idempotency

Hopper over hvis `derived/{eventId}/{mediaId}/preview.mp4` finnes fra før.

## Failure-modus

- For stor (> MAX_INPUT_BYTES) → 204 (ack, ingen retry — ikke noe å gjøre)
- ffmpeg-feil → 500, Pub/Sub retry, DLQ etter 5 forsøk
- Korrupt video → 500 → DLQ
- Ikke-video contentType → 204 (stille skip — image-processor håndterer den)
