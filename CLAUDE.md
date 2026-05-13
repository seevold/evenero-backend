# Evenero — git+deploy regime

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

## Skjema-migrering

Skjema-endringer kjøres MANUELT mot DB FØR kode-deploy. Skript bevares i `/tmp/evenero-audit/` (denne sessjonen) eller dokumentert per migrering.

DB-bruker for migrering:
- Staging: `postgres` med `staging-db-password`
- Prod: `postgres` med `prod-db-password-postgres` (via Cloud SQL Auth Proxy + IAM som Owner)
