# evenero-backend

Backend-tjenester for Evenero, deployed til Google Cloud Run.

## Struktur

```
evenero-backend/
├── services/
│   ├── main-api/       Express-API for evenero-app (~67 endepunkter)
│   └── web-api/        Express-API for evenero-web (Stripe-webhook, support, Meta CAPI)
└── shared/             (planlagt: felles typer mellom services — i dag duplisert i hver service/src/shared)
```

## Lokal utvikling

Hvert service har egen `package.json`. Start med:

```bash
cd services/main-api
npm install
npm run dev          # tsx watch-mode, port 8080 default
```

```bash
cd services/web-api
npm install
npm run dev
```

### Env-vars

For lokal dev, lag `.env`-fil i hver service-mappe (eller bruk `.envrc` med direnv).

**main-api**:
```
DATABASE_URL=postgresql://user:pass@host/db
JWT_SECRET=<random>
GCS_BUCKET_NAME=evenero-staging-cloud
GCP_PROJECT_ID=evenero
SMTP_HOST=...
SMTP_PORT=587
SMTP_USER=...
SMTP_PASSWORD=...
SMTP_FROM=noreply@evenero.com
EMAIL_WHITELIST_TO=lasse@styretavla.no   # staging only — tvinger all utgående mail hit
PUBLIC_APP_URL=https://evenero-app-staging.vercel.app
CORS_ORIGINS=https://evenero-app-staging.vercel.app,http://localhost:5173
ENABLE_REMINDER_SCHEDULER=false          # true kun hvis --min-instances=1 i prod
PORT=8080
```

**web-api**:
```
DATABASE_URL=postgresql://user:pass@host/db
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
MAILGUN_API_KEY=...
META_ACCESS_TOKEN=...
EMAIL_WHITELIST_TO=lasse@styretavla.no
CORS_ORIGINS=https://evenero-web.vercel.app,http://localhost:5173
PORT=8080
```

For Cloud Run-deploy: env-vars settes via `gcloud run deploy --set-secrets` (referer Secret Manager) og `--set-env-vars` (ikke-sensitive).

## Deploy

Manuell deploy (Fase 1):

```bash
# main-api
cd services/main-api
gcloud run deploy main-api-staging \
  --source . \
  --region europe-north1 \
  --project evenero \
  --add-cloudsql-instances evenero:europe-north1:evenero-db-staging \
  --set-secrets "JWT_SECRET=staging-jwt-secret:latest,DB_PASSWORD=staging-db-password:latest,SMTP_PASSWORD=staging-smtp-password:latest" \
  --set-env-vars "CLOUD_SQL_INSTANCE=evenero:europe-north1:evenero-db-staging,DB_USER=postgres,DB_NAME=postgres,GCS_BUCKET_NAME=evenero-staging-cloud,GCP_PROJECT_ID=evenero,EMAIL_WHITELIST_TO=lasse@styretavla.no,PORT=8080" \
  --allow-unauthenticated \
  --memory 512Mi \
  --max-instances 1
```

Cloud Build-trigger (planlagt Fase 2): push til `main` → bygg + deploy automatisk.

## TypeScript-status

| Service | tsc check | esbuild bundle |
|---|---|---|
| main-api | ✅ Passerer | ✅ |
| web-api | ⚠️ Pre-eksisterende TS-feil fra Refresh-kode (Drizzle-types) | ✅ Bundler likevel |

web-api sine TS-feil er drizzle-zod insert-skjema-mismatch på `payments`/`support_requests`-tabellene. Bundle fungerer fordi esbuild ignorerer typing. Skal ryddes i pass 2.

## Migrasjoner

DB-migrasjoner er **manuelle** for nå. Se `services/main-api/src/migrations.ts` for hvilken SQL som må kjøres mot staging-DB.

For staging-bootstrap: schema-only `pg_dump` fra prod (`evenero-db-1`) → restore til staging (`evenero-db-staging`).

## Cleanup-/maintenance-logikk

Eksisterende Python Cloud Functions (`delete_files`, `make_thumbnails`, etc.) håndterer cleanup i prod. For staging er det INGEN cleanup ennå — staging-bucket er tom. Egen `EVENERO-CLEANUP-PLAN.md` skrives senere.

**Kritisk prinsipp:** Aktiv kunde-data slettes ALDRI automatisk uten eksplisitt eier-handling.
