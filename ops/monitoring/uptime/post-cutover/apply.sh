#!/usr/bin/env bash
# Cutover-script: bytter uptime checks fra Vercel-hostnames til evenero.com-domener.
#
# Kjøres ÉN gang etter DNS-cutover er fullført og verifisert. Skriptet:
#   1. Smoke-tester at nye domener faktisk svarer 200 (avbryter hvis ikke)
#   2. Sletter de gamle Vercel-uptime-checks
#   3. Oppretter nye uptime-checks for event.evenero.com og evenero.com
#
# Backend Cloud Run-uptime-checks (main-api, web-api) berøres IKKE — de bruker
# *.run.app-URLer som er stabile uansett cutover.

set -e

PROJECT=evenero
REGION=europe-north1

echo "═══════════════════════════════════════════"
echo " Cutover: bytt Vercel→domain uptime checks"
echo "═══════════════════════════════════════════"
echo ""

echo "─── Steg 1: verifiser at nye domener svarer 200 ───"
for HOST in event.evenero.com evenero.com; do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "https://$HOST/")
  if [[ "$CODE" != "200" ]]; then
    echo "  ❌ https://$HOST/ returnerte $CODE (forventet 200)"
    echo "  Avbryter — sjekk at DNS faktisk peker på Vercel og at SSL er klar."
    exit 1
  fi
  echo "  ✅ https://$HOST/ → $CODE"
done

echo ""
echo "─── Steg 2: finn og slett gamle Vercel-uptime-checks ───"
for VERCEL_HOST in evenero-app.vercel.app evenero-web.vercel.app; do
  ID=$(gcloud monitoring uptime list-configs --project=$PROJECT \
    --filter="monitoredResource.labels.host=$VERCEL_HOST" \
    --format="value(name)" 2>/dev/null | head -1)
  if [[ -n "$ID" ]]; then
    echo "  Sletter check for $VERCEL_HOST: $ID"
    gcloud monitoring uptime delete "$ID" --project=$PROJECT --quiet
  else
    echo "  (ingen check for $VERCEL_HOST — kanskje allerede slettet)"
  fi
done

echo ""
echo "─── Steg 3: opprett nye uptime-checks for cutover-domener ───"
gcloud monitoring uptime create "evenero-app frontend (event.evenero.com)" \
  --resource-type=uptime-url \
  --resource-labels=host=event.evenero.com,project_id=$PROJECT \
  --path="/" --port=443 --protocol=https \
  --status-classes=2xx \
  --period=5 --timeout=10 \
  --project=$PROJECT

gcloud monitoring uptime create "evenero-web frontend (evenero.com)" \
  --resource-type=uptime-url \
  --resource-labels=host=evenero.com,project_id=$PROJECT \
  --path="/" --port=443 --protocol=https \
  --status-classes=2xx \
  --period=5 --timeout=10 \
  --project=$PROJECT

echo ""
echo "─── Steg 4: verifiser ───"
gcloud monitoring uptime list-configs --project=$PROJECT \
  --format="table(displayName,monitoredResource.labels.host,httpCheck.path)"

echo ""
echo "✅ Ferdig. uptime-alert.json fortsetter å fyre alarm hvis 2+ regioner"
echo "   rapporterer feil i 2 sammenhengende vinduer."
