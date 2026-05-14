# GCP Monitoring — alert policies + uptime checks

Disse JSON-filene definerer Cloud Monitoring alert policies + uptime checks
som sender e-post til `lasse@cadas.no` ved kritiske prod-feil. Alle er
deployet og aktive i `evenero`-prosjektet.

## Alert policies

| Fil | Hva den fanger |
|---|---|
| `oom.json` | Cloud Run-container drept for memory limit (alle 5 prod-services) |
| `crash.json` | Container startup-feil eller non-zero exit (alle 5 prod-services) |
| `5xx.json` | 5xx-rate > 5% over 5 min (main-api + web-api prod) |
| `db.json` | Cloud SQL connection-feil i main-api eller web-api prod |
| `uptime-alert.json` | Uptime checks feiler i 2+ regioner (se uptime/ for hvilke endpoints) |

I tillegg eksisterer fra før:
- `media-uploaded-dlq: meldinger publisert` — image-/video-processor DLQ
  (ble satt opp manuelt før dette repo-versjonering startet)

## Uptime checks (uptime/)

Eksterne Google-prober mot prod-endpoints fra Europe, USA, Asia-Pacific
hver 5. minutt. Failure trigger `uptime-alert.json`.

| Fil | Endpoint |
|---|---|
| `uptime-main-api.json` | `https://main-api-467452422363.europe-north1.run.app/api/health` |
| `uptime-web-api.json` | `https://web-api-467452422363.europe-north1.run.app/api/email-test` |
| `uptime-evenero-app.json` | `https://evenero-app.vercel.app/` |
| `uptime-evenero-web.json` | `https://evenero-web.vercel.app/` |

**Etter cutover:** oppdater `host` i JSON-ene til `event.evenero.com`,
`evenero.com`, etc. og recreate via gcloud.

## Notification channel

Alle alerts sender til samme channel:
`projects/evenero/notificationChannels/17116521427358004824` →
`lasse@cadas.no`

Hvis du legger til flere mottakere (f.eks. co-host eller backup-konto):

```bash
gcloud beta monitoring channels create \
  --display-name="Lasse SMS" \
  --type=sms \
  --channel-labels=number=+47XXXXXXXX \
  --project=evenero
```

Deretter oppdater hver policy.json med channel-ID-en i `notificationChannels`-arrayet.

## Recreate fra repo (hvis sletet ved uhell)

```bash
for f in oom crash 5xx db; do
  gcloud beta monitoring policies create \
    --policy-from-file=ops/monitoring/$f.json \
    --project=evenero
done
```

## Hvorfor disse 4 og ikke flere?

Listet bevisst slank for å unngå støy. Disse trigger kun ved user-affecting
feil:

- OOM/crash → service er nede eller restarter → brukere får 500
- 5xx-rate → bug i ny deploy eller downstream-feil
- DB connection → hele app-en står

**Skippet bevisst:**
- CPU/memory utilization warnings — Cloud Run autoscales, ikke handlingsverdig
- Quota warnings — vi er langt under quota-grenser
- Latency-spikes — Cloud Run cold-start gir naturlige spikes som ikke betyr
  noe; ville generere falskpositive
- Storage-bucket-events — sjeldne og ikke umiddelbart user-affecting

## Tweaking

Hvis du får for mange falskpositive, juster terskler i JSON-en og kjør:

```bash
# Finn policy-ID (display-name → ID)
gcloud beta monitoring policies list --project=evenero \
  --filter="displayName:'5xx-rate'" --format="value(name)"

# Slett gammel
gcloud beta monitoring policies delete <full/policy/path> --project=evenero --quiet

# Lag ny fra oppdatert JSON
gcloud beta monitoring policies create \
  --policy-from-file=ops/monitoring/5xx.json \
  --project=evenero
```

## Test at e-post fungerer

Send testvarsel til channel:

```bash
gcloud beta monitoring channels verify \
  projects/evenero/notificationChannels/17116521427358004824 \
  --project=evenero
```
