# cleanup-job

Cloud Run **Job** (ikke service) som rydder GCS-bucket etter retention-regler.
Triggers fra Cloud Scheduler daglig 03:00 Europe/Oslo.

## Hva den sletter

| Kategori | Trigger | Grace |
|---|---|---|
| 1 — Arkivert media | `event_images.archived=true AND archived_at < NOW() - 30d` | 30 dager |
| 2 — Avvist av moderator | `moderation_status='rejected' AND moderated_at < NOW() - 30d` | 30 dager |
| 3 — Tilhører slettet event | `events.deleted_at < NOW() - 30d` (matchet via `event_id`) | 30 dager |
| 4 — Orphan GCS-fil (valgfri) | Fil i bucket men ikke referert i DB, og fil eldre enn 7 dager | 7 dager (alder), `CLEANUP_SCAN_ORPHANS=true` |

## Hva den IKKE rør

- Filer referert av `event_images.image_url` for ikke-purged rader
- Filer referert av `events.event_photo` for aktive eventer + soft-deleted innenfor grace-perioden
- Aktive event-bilder, aktive cover-photos, v2-derivater for aktive originaler

## Safety-rails

- **DRY_RUN er default true** — eksplisitt `CLEANUP_DRY_RUN=false` må settes for live sletting.
- **Caps:** max 1000 filer + 10 GB per kjøring. Halt + alert hvis overskredet.
- **DB-rad bevares:** vi setter `event_images.files_purged_at = NOW()` etter GCS-sletting,
  i stedet for å slette raden. Bevarer historiske stats.
- **v1 + v2 dual-handling** via samme logikk som main-api's `permanent-delete`-rute.

## Env-vars

| Var | Default | Beskrivelse |
|---|---|---|
| `GCS_BUCKET_NAME` | (required) | `evenero-staging-cloud` / `evenero-cloud` |
| `CLOUD_SQL_INSTANCE` | (required for Cloud Run) | f.eks. `evenero:europe-north1:evenero-db-staging` |
| `DB_IAM_AUTH` | `false` | `true` for prod IAM-auth |
| `DB_USER`, `DB_PASSWORD`, `DB_NAME` | — | Standard pg-creds (kun hvis ikke IAM) |
| `CLEANUP_DRY_RUN` | `true` | Sett til `false` for live sletting |
| `CLEANUP_GRACE_DAYS` | `30` | Grace-periode for kategori 1-3 |
| `CLEANUP_MAX_FILES_PER_RUN` | `1000` | Halt hvis flere kandidater |
| `CLEANUP_MAX_BYTES_PER_RUN` | `10737418240` (10 GB) | Halt hvis estimert volum overstiger |
| `CLEANUP_SCAN_ORPHANS` | `false` | Skru på orphan-scan (dyrere, mer risikabelt) |
| `CLEANUP_ORPHAN_GRACE_DAYS` | `7` | Alder-filter for orphan (beskytter mot in-flight uploads) |
| `ALERT_EMAIL` | — | E-post for halt/anomaly-alert (stille no-op hvis ikke satt) |
| `MAILGUN_API_KEY` | — | Samme secret som main-api bruker (Mailgun HTTP API). |
| `MAILGUN_DOMAIN`, `MAILGUN_API_BASE`, `MAILGUN_FROM`, `MAILGUN_FROM_NAME` | (defaults) | Vanligvis ikke nødvendig å overstyre — defaults matcher prod. |

## Engangs-setup (manuelt i GCP)

Cloud Run **Jobs** opprettes første gang manuelt. Etterpå oppdaterer Cloud Build kun image-en
ved push til `staging` / `main`.

### Staging

```bash
# 1. Bygg image (én gang manuelt) eller la første cloud-build pushe den
# 2. Opprett job
gcloud run jobs create cleanup-job-staging \
  --image=europe-north1-docker.pkg.dev/evenero/cloud-run-source-deploy/cleanup-job-staging:latest \
  --region=europe-north1 \
  --project=evenero \
  --service-account=staging-runner@evenero.iam.gserviceaccount.com \
  --task-timeout=30m \
  --max-retries=0 \
  --memory=512Mi \
  --cpu=1 \
  --set-env-vars=\
GCS_BUCKET_NAME=evenero-staging-cloud,\
CLOUD_SQL_INSTANCE=evenero:europe-north1:evenero-db-staging,\
DB_USER=postgres,\
DB_NAME=postgres,\
CLEANUP_DRY_RUN=true,\
CLEANUP_GRACE_DAYS=30,\
CLEANUP_SCAN_ORPHANS=false,\
ALERT_EMAIL=lasse@styretavla.no,\
MAILGUN_DOMAIN=www.evenero.com,\
MAILGUN_API_BASE=https://api.eu.mailgun.net/v3 \
  --set-secrets=\
DB_PASSWORD=staging-db-password:latest,\
MAILGUN_API_KEY=staging-mailgun-api-key:latest

# 3. Cloud Build trigger (én gang)
gcloud builds triggers create github \
  --name=cleanup-job-staging-deploy \
  --repo-name=evenero-backend \
  --repo-owner=seevold \
  --branch-pattern=^staging$ \
  --build-config=services/cleanup-job/cloudbuild.yaml \
  --included-files=services/cleanup-job/** \
  --region=europe-north1 \
  --project=evenero

# 4. Cloud Scheduler — daglig 03:00 Europe/Oslo
gcloud scheduler jobs create http cleanup-job-staging-cron \
  --schedule="0 3 * * *" \
  --time-zone="Europe/Oslo" \
  --location=europe-west1 \
  --uri="https://europe-north1-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/evenero/jobs/cleanup-job-staging:run" \
  --http-method=POST \
  --oauth-service-account-email=staging-runner@evenero.iam.gserviceaccount.com \
  --oauth-token-scope=https://www.googleapis.com/auth/cloud-platform \
  --project=evenero
```

### Prod

Samme som over, men:
- Service-account: `prod-runner@evenero.iam.gserviceaccount.com`
- DB: `evenero:europe-north1:evenero-db-1` + `DB_IAM_AUTH=true`, ingen `DB_USER`/`DB_PASSWORD`
- Bucket: `evenero-cloud`
- Cloud Build trigger: `--branch-pattern=^main$`, `--build-config=services/cleanup-job/cloudbuild-prod.yaml`
- Job-navn: `cleanup-job` (uten `-staging`)

## Manuell trigger / ad-hoc kjøring

```bash
# Dry-run (default)
gcloud run jobs execute cleanup-job-staging --region=europe-north1 --project=evenero --wait

# Live (NB: krever at job-en har CLEANUP_DRY_RUN=false satt i env)
gcloud run jobs update cleanup-job-staging \
  --region=europe-north1 \
  --update-env-vars=CLEANUP_DRY_RUN=false
gcloud run jobs execute cleanup-job-staging --region=europe-north1 --project=evenero --wait
# Husk å sette tilbake til true etterpå hvis du vil ha dry-run igjen
```

## Cutover-plan (dry-run → live)

1. Deploy til staging med `CLEANUP_DRY_RUN=true` og `CLEANUP_SCAN_ORPHANS=false`.
2. Kjør manuelt 1×, gjennomgå Cloud Logging-output.
3. Lag noen test-rader i staging-DB (en arkivert >30d, en rejected >30d, et soft-deleted event).
4. Kjør dry-run igjen, verifiser at de test-radene plukkes opp.
5. Skru på live (`CLEANUP_DRY_RUN=false`) for kategori 1-3. La løpe 1-2 uker.
6. Verifiser at `files_purged_at` settes korrekt på purgede rader.
7. Skru på orphan-scan (`CLEANUP_SCAN_ORPHANS=true`) i staging. Kjør dry-run igjen, gjennomgå.
8. Live orphan-scan i staging.
9. Repeat steg 1-8 på prod, mer konservativt.

## Lokal kjøring (mot staging-DB)

```bash
cd services/cleanup-job
npm install

# Sett env (eksempel — bruk din egen staging-creds):
export GCS_BUCKET_NAME=evenero-staging-cloud
export DATABASE_URL=postgresql://postgres:PASS@127.0.0.1:5432/postgres  # via Cloud SQL proxy
export CLEANUP_DRY_RUN=true
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/staging-runner-key.json   # eller `gcloud auth application-default login`

npm run dev
```
