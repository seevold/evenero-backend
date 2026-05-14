# Evenero — git+deploy regime

> **STOPP — les dette først (gjelder enhver ny Claude-sesjon):**
>
> Før du gjør noen kode-endring i dette repoet, les
> `~/.claude/projects/-Users-lasse-Projects-Evenero/memory/workflow.md`
> og kjør sesjon-start-prosedyren som er beskrevet der. Det inneholder
> beslutningstreet (bugfix vs feature vs hotfix vs sync), eksakte git-
> kommandoer per scenario, og MÅ-reglene for branch-merging.
>
> Lasse er solo-dev og forventer at du styrer branch-strategien selv —
> han skal ikke trenge å nevne `staging`, `main`, `feature/*` eller
> `hotfix/*` for at riktig flyt skal skje. Workflow.md er kilden.
>
> Filen under er repo-spesifikk konfig (Cloud Run-services, SA-er, DB-er).
> Workflow.md overstyrer alt om branch-flyt.

---

## Branches → miljø

| Branch | Cloud Run-services | Cloud Build-trigger |
|---|---|---|
| `staging` | `<service>-staging` | `*-staging-deploy` (`cloudbuild.yaml`) |
| `main` | `<service>` (prod) | `*-deploy` (`cloudbuild-prod.yaml`) |

## Flyt

**Standard (test først):**
```
git checkout staging
# endre kode
git push origin staging          # → staging Cloud Run deploy
# test på staging.evenero.com / staging-app.evenero.com
git checkout main && git merge staging
git push origin main             # → prod Cloud Run deploy
```

**Akutt prod-fix:** commit direkte til `main`, push, **så umiddelbart**:
```
git checkout staging && git merge main && git push origin staging
```

Aldri la `main` ligge foran `staging`. Bruk:
```bash
git log --oneline origin/staging..origin/main
```
For å sjekke drift før commit.

## Services i dette repoet (5 stk)

| Mappe | Staging-service | Prod-service |
|---|---|---|
| `services/main-api` | `main-api-staging` | `main-api` |
| `services/web-api` | `web-api-staging` | `web-api` |
| `services/zipper-service-v2` | `zipper-service-v2-staging` | `zipper-service-v2` |
| `services/image-processor` | `image-processor-v2-staging` | `image-processor-v2` |
| `services/video-processor` | `video-processor-v2-staging` | `video-processor-v2` |

## Service accounts

- Staging: `staging-runner@evenero.iam.gserviceaccount.com`
- Prod: `prod-runner@evenero.iam.gserviceaccount.com`

## DB

- Staging: `evenero-db-staging` (passord-auth)
- Prod: `evenero-db-1` (IAM-auth via prod-runner)

## Bucket

- Staging: `evenero-staging-cloud`
- Prod: `evenero-cloud`

## Pub/Sub topics

- Staging: `media-uploaded` (GCS notification på evenero-staging-cloud/originals/)
- Prod: `media-uploaded-prod` (GCS notification på evenero-cloud/originals/)

## Cloud Tasks

- Staging: `zip-queue-v2-staging` (europe-west1)
- Prod: `zip-queue-v2-prod` (europe-west1)

## Miljø-spesifikke env-vars (fail-fast — ingen prod-fallbacks)

Hver Cloud Run-service har env-vars som ER miljø-spesifikke. Disse skal IKKE
ha hardkodede fallbacks i koden — tidligere defaultet flere til prod-verdier,
som silent kunne mate staging til prod-bucket / prod-URL / live Stripe hvis
env-var ble fjernet ved et uhell.

**Mønster:** bruk `required('VAR_NAME')` eller `throw new Error(...)` hvis env
ikke er satt. Bedre å feile høyt ved oppstart enn å silent kjøre mot feil miljø.

| Env-var | Prod-verdi | Staging-verdi | Service |
|---|---|---|---|
| `GCS_BUCKET_NAME` | `evenero-cloud` | `evenero-staging-cloud` | main-api, image-processor-v2, video-processor-v2, zipper-service-v2 |
| `CLOUD_SQL_INSTANCE` | `evenero:europe-north1:evenero-db-1` | `evenero:europe-north1:evenero-db-staging` | main-api, web-api |
| `QUEUE_NAME` | `zip-queue-v2-prod` | `zip-queue-v2-staging` | zipper-service-v2 |
| `SERVICE_URL` | `https://zipper-service-v2-467...run.app` | `https://zipper-service-v2-staging-467...run.app` | zipper-service-v2 |
| `WEBHOOK_URL` | prod main-api `/api/zip-ready` | staging main-api `/api/zip-ready` | zipper-service-v2 |
| `PUBLIC_APP_URL` | `https://event.evenero.com` | `https://staging-app.evenero.com` | main-api |
| `CORS_ORIGINS` | `https://evenero.com,https://event.evenero.com,...` | `https://staging.evenero.com,https://staging-app.evenero.com,...` | main-api, web-api |
| `STRIPE_PRODUCT_ID` | live product-ID | test product-ID | web-api |
| `EMAIL_WHITELIST_TO` | tom (cutover-fase: send til kun whitelist) | testadresse (reruter ALL e-post) | main-api, web-api |
| `DATABASE_URL` / `DB_*` | prod IAM-auth | staging password-auth | main-api, web-api |

**Når du legger til en ny miljø-spesifikk env-var:** ALDRI bruk
`process.env.X || 'fallback-prod-value'`. Bruk `required('X')` (mønstret i
zipper-service-v2/src/config.ts) eller eksplisitt throw.

## Media path-konvensjoner (v1 vs v2 — KRITISK)

`event_images.image_url` kan peke på to forskjellige strukturer. **Eventer
opplastet i cutover-fasen har mix av begge i samme galleri** — all kode som
leser eller bygger media-paths må håndtere begge.

| | v1 (legacy Replit, gjennom cutover) | v2 (Cloud Run / Pub/Sub-pipeline) |
|---|---|---|
| Original | `images/{eventId}__{batchId}__{seq}__{name}.{ext}` (flat) | `originals/{eventId}/{mediaId}.{ext}` (mappe per event) |
| Bilde-thumbnail | `images/{name}_small.{ext}` (samme dir, suffiks) | `derived/{eventId}/{mediaId}/{thumb,medium}.webp` |
| Video-derivat | `images/{name}_compressed.{ext}` | `derived/{eventId}/{mediaId}/preview.mp4` + `poster.jpg` |
| Hvem lager derivat | Replit make-thumbnails (legacy, fases ut) | image-processor-v2 / video-processor-v2 via Pub/Sub |
| mediaId | n/a (intet stabilt id i path) | UUID == `event_images.id` |

**Deteksjon av v2-path** (kanonisk regex):
```ts
const v2Match = imageUrl.match(/^(.*)\/originals\/([^/]+)\/([^/]+)\.[^./]+$/);
// v2Match[1]=base, [2]=eventId, [3]=mediaId
```

**Bygging av derived-URL (v2):**
```ts
`${base}/derived/${eventId}/${mediaId}/{thumb.webp | medium.webp | poster.jpg | preview.mp4}`
```

**Bygging av derivat-path (v1) — bruk `getDerivativePath` i `gcs.ts`:**
- Bilde: `name.ext` → `name_small.ext`
- Video: `name.mp4` → `name_compressed.mp4`

**Sletting** (v1 + v2 i ett kall) — se `permanent-delete`-routen i
`services/main-api/src/routes.ts`. v2: `deletePrefix('derived/{ev}/{med}/')`.
v1: `deleteFile(derivativePath)`.

**ZIP-download** håndteres av `zipper-service-v2`, som prøver flere paths via
`SEARCH_PATH_TEMPLATES` (`originals/{eventId}/{mediaId}` + v1-paths). Path-
matching er løsere enn vi tror — sjekk env-var hvis ny path-konvensjon
introduseres.

**Kjente lekkasjer:** `storage.deleteEvent` er soft-delete — sletter ikke GCS-
filer for verken v1 eller v2 (komment i koden bekrefter "ikke implementert
ennå"). Bilder/videoer blir orphan i bucket inntil en hard-delete cron lages.

**Når du bygger nye features som leser `image_url`:** alltid håndter begge
formater, eller dokumenter eksplisitt at du kun støtter ett. Frontend har
samme regel — se `client/src/pages/gallery.tsx:693-745` og
`client/src/pages/slideshow.tsx:34-65` for kanoniske eksempler.

## Skjema-migrering

Skjema-endringer kjøres MANUELT mot DB FØR kode-deploy. Skript bevares i `/tmp/evenero-audit/` (denne sessjonen) eller dokumentert per migrering.

DB-bruker for migrering:
- Staging: `postgres` med `staging-db-password`
- Prod: `postgres` med `prod-db-password-postgres` (via Cloud SQL Auth Proxy + IAM som Owner)
