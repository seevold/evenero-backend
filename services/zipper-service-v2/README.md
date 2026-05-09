# zipper-service-v2

Cloud Run-tjeneste som genererer ZIP-arkiver av event-media. Erstatning for `zipper-service` (v1, europe-west1, API_KEY-auth).

**Endringer fra v1:**
- TypeScript i stedet for plain JS
- OIDC-auth i stedet for `X-API-Key`-header
- v2-path-fallback (`originals/{eventId}/{mediaId}` først, så v1-paths)
- Output i `derived/zip/`-prefiks (separat fra `derived/{eventId}/...` for å forenkle lifecycle-regler)
- Region europe-north1 (matcher andre v2-services)
- Lavere `max-instances` (5 vs 100) — det reelle rekkverket er Cloud Tasks rate-limit
- Cloud Tasks-queue `zip-queue-v2-staging` med `max-dispatches-per-second=2`

## Trigger-flyt

```
Klient (OIDC) → POST /zip → Cloud Tasks (rate-limited) → POST /process-zip
                                                          ↓
                                                       buildZip() (sequential streaming)
                                                          ↓
                                                       upload til derived/zip/{name}.zip
                                                          ↓
                                                       webhook (optional) + signed URL response
```

`/zip` returnerer `{ jobId, expectedFileName }` med 202. Webhook-callback eller polling brukes for å vente på fullføring.

## Path-fallback under cutover-perioden

`SEARCH_PATH_TEMPLATES` env-var lister stier som prøves i rekkefølge for hver `mediaId`:

```
originals/{eventId}/{mediaId},images/{mediaId},images/{eventId}/{mediaId},{mediaId}
```

→ v2-uploads finnes som `originals/...`, gamle som `images/...`. Mixed-event ZIP funker uten kodeendring.

## Lifecycle-regel

På bucket `evenero-staging-cloud` (og senere prod):

```bash
gsutil lifecycle set lifecycle.json gs://evenero-staging-cloud
```

med innhold:

```json
{
  "rule": [
    { "action": {"type": "Delete"},
      "condition": {"matchesPrefix": ["derived/zip/"], "age": 7} }
  ]
}
```

Signed URL utløper på 7 dager uansett, så filene har ingen verdi etter det.

## Cloud Tasks queue (engangs-oppsett)

```bash
gcloud tasks queues create zip-queue-v2-staging \
  --location=europe-north1 \
  --max-dispatches-per-second=2 \
  --max-concurrent-dispatches=5 \
  --max-attempts=3 \
  --project=evenero
```

## Konfig (env-vars)

| Var | Default | Beskrivelse |
|---|---|---|
| `GCS_BUCKET_NAME` | (required) | Bucket for input + output |
| `GCP_PROJECT_ID` | (required) | For Cloud Tasks queue path |
| `QUEUE_LOCATION` | `europe-north1` | Cloud Tasks region |
| `QUEUE_NAME` | `zip-queue-v2-staging` | |
| `SERVICE_URL` | (required) | Egen URL — Cloud Tasks må vite hvor /process-zip ligger |
| `WORKER_SERVICE_ACCOUNT` | (required) | OIDC-issuer for Cloud Tasks → /process-zip |
| `ZIP_PREFIX` | `derived/zip/` | Hvor ZIP-filer skrives |
| `SIGNED_URL_EXPIRY_DAYS` | `7` | Match lifecycle-regelen |
| `SEARCH_PATH_TEMPLATES` | (se over) | Komma-liste av path-templates |
| `WEBHOOK_URL` | (optional) | Callback ved fullført/feilet ZIP |

## Test fra terminal

```bash
SERVICE_URL=$(gcloud run services describe zipper-service-v2 --region europe-north1 --format='value(status.url)')

# 1. Last opp et par testbilder
gsutil cp test1.jpg gs://evenero-staging-cloud/originals/zip-test/m1.jpg
gsutil cp test2.jpg gs://evenero-staging-cloud/originals/zip-test/m2.jpg

# 2. Trigger ZIP
ID_TOKEN=$(gcloud auth print-identity-token --audiences=$SERVICE_URL)
curl -X POST $SERVICE_URL/zip \
  -H "Authorization: Bearer $ID_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mediaIds":["m1.jpg","m2.jpg"],"eventName":"Zip Test","eventId":"zip-test","userEmail":"test@example.com"}'

# 3. Vent ~10 sek, sjekk derived/zip/
gsutil ls -l gs://evenero-staging-cloud/derived/zip/
```

## Failure-modus

- Manglende fil → registreres i `errors[]`, fortsetter med resten
- Alle filer manglende → 500, Cloud Tasks retry m/ exponential backoff (max 3 forsøk per queue-konfig)
- ffmpeg/sharp er ikke involvert — ren Node-streaming, dust ressursbruk
