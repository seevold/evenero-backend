# image-processor

Cloud Run-tjeneste som genererer WebP-varianter (`thumb` 384px, `medium` 1600px) av opplastede bilder.

**Trigger:** GCS object finalize på `evenero-cloud` (eller staging-bucket) → Pub/Sub topic `media-uploaded` → push subscription til denne tjenesten.

**Path-konvensjon:**
```
input:  {bucket}/originals/{eventId}/{mediaId}.{ext}
output: {bucket}/derived/{eventId}/{mediaId}/thumb.webp
        {bucket}/derived/{eventId}/{mediaId}/medium.webp
```

Ingen interaksjon med `images/`-prefiks (v1-layout). Den gamle Python-funksjonen `make_thumbnails` lever videre for v1-uploads inntil cutover-fase.

## Lokal utvikling

```bash
npm install
GCS_BUCKET_NAME=evenero-staging-cloud \
  GOOGLE_APPLICATION_CREDENTIALS=~/keys/claude-deploy.json \
  npm run dev
```

For lokal test uten Pub/Sub:

```bash
# Last opp et testbilde
gsutil cp test.jpg gs://evenero-staging-cloud/originals/test-event/test-media.jpg

# Simuler Pub/Sub push
curl -X POST http://localhost:8080/ -H 'content-type: application/json' -d '{
  "message": {
    "data": "'$(echo -n '{"bucket":"evenero-staging-cloud","name":"originals/test-event/test-media.jpg","contentType":"image/jpeg"}' | base64)'"
  }
}'

# Verifiser
gsutil ls gs://evenero-staging-cloud/derived/test-event/test-media/
```

## Konfig (env-vars)

| Var | Default | Beskrivelse |
|---|---|---|
| `GCS_BUCKET_NAME` | (required) | Bucket for input + output |
| `INPUT_PREFIX` | `originals` | Prefiks for input-objekter |
| `OUTPUT_PREFIX` | `derived` | Prefiks for output-varianter |
| `THUMB_SIZE` | `384` | Maks lengste side, thumb |
| `MEDIUM_SIZE` | `1600` | Maks lengste side, medium |
| `THUMB_QUALITY` | `72` | WebP-kvalitet, thumb |
| `MEDIUM_QUALITY` | `78` | WebP-kvalitet, medium |
| `MAX_INPUT_BYTES` | `52428800` | 50 MB hard cap mot decompression bombs |
| `PORT` | `8080` | (Cloud Run setter selv) |

## Cloud Run-deploy (anbefalt)

```bash
gcloud run deploy image-processor-v2 \
  --source . \
  --region europe-north1 \
  --project evenero \
  --no-allow-unauthenticated \
  --set-env-vars GCS_BUCKET_NAME=evenero-staging-cloud \
  --service-account image-processor-sa@evenero.iam.gserviceaccount.com \
  --memory 1Gi \
  --cpu 1 \
  --concurrency 4 \
  --max-instances 25 \
  --min-instances 0 \
  --timeout 120s
```

## Idempotency

Hopper over hvis `derived/{eventId}/{mediaId}/thumb.webp` finnes fra før. Trygt mot Pub/Sub redelivery og manuelle re-trigger.

## Failure-modus

- Korrupt input → 500, Pub/Sub retry, DLQ etter `maxDeliveryAttempts=5`
- Ukjent path-skjema → 204 (ack, ingen retry — ikke noe å gjøre)
- Feil bucket → 204 (ack, ikke vår oppgave)
