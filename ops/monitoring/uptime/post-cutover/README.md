# Post-cutover uptime checks

Disse JSON-konfigene er IKKE deployet ennå. De er klar til å aktiveres når
DNS-cutover er fullført (Replit → Vercel for `evenero.com`-domenene).

## Hva som ligger her

| Fil | For-cutover-tilstand | Etter-cutover-tilstand |
|---|---|---|
| `uptime-event-evenero.json` | erstatter `uptime-evenero-app.json` | monitorer `event.evenero.com` |
| `uptime-evenero.json` | erstatter `uptime-evenero-web.json` | monitorer `evenero.com` |
| `apply.sh` | (ikke kjørt) | bytter Vercel→domain-checks i én operasjon |

## Cutover-prosedyre

Når DNS-cutover er gjort og du har bekreftet at `event.evenero.com` og
`evenero.com` faktisk treffer Vercel (og ikke Replit), kjør:

```bash
cd /Users/lasse/Projects/Evenero/repos/evenero-backend
bash ops/monitoring/uptime/post-cutover/apply.sh
```

Skriptet:
1. Smoke-tester at nye domener svarer 200 (avbryter hvis ikke)
2. Sletter gamle uptime-checks for `evenero-app.vercel.app` + `evenero-web.vercel.app`
3. Oppretter nye uptime-checks for `event.evenero.com` + `evenero.com`
4. Lister nåværende state for verifisering

Backend Cloud Run-uptime-checks (main-api, web-api) berøres ikke — de bruker
stabile `*.run.app`-URLer.

## Hvis cutover må rulles tilbake

Hvis DNS må roteres tilbake til Replit (catastrofic rollback), kjør:
```bash
# Slett domain-checks
for HOST in event.evenero.com evenero.com; do
  ID=$(gcloud monitoring uptime list-configs --project=evenero \
    --filter="monitoredResource.labels.host=$HOST" \
    --format="value(name)" | head -1)
  [[ -n "$ID" ]] && gcloud monitoring uptime delete "$ID" --project=evenero --quiet
done

# Recreate Vercel-checks fra ops/monitoring/uptime/uptime-evenero-{app,web}.json
# via gcloud monitoring uptime create (se kommandoene i parent README.md)
```

## Hvorfor monitorer vi ikke nåværende DNS (Replit) nå?

Brukerens valg — Replit blir borte etter cutover, og det er ingen verdi i
å motta alerts om Replit-issues når vi uansett ikke kan fikse det fra denne
stacken. Vercel-deploys er allerede monitored direkte via `evenero-app.vercel.app`
+ `evenero-web.vercel.app` som tester at Cloud Run-backend + Vercel-frontend
fungerer ende-til-ende uavhengig av DNS.
