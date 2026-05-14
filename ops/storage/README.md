# GCS / Artifact Registry — lifecycle og cleanup

Begge konfig-filer er aktive i `evenero`-prosjektet og holder lagrings-
forbruk i sjakk.

## artifact-cleanup.json

Cleanup-policy på Artifact Registry-repo `cloud-run-source-deploy`
(europe-north1). Container-images for alle 5 Cloud Run-services lagres
her.

Tre regler:
1. **Keep:** alle `latest`-tags beholdes alltid
2. **Keep:** 5 nyeste versjoner per package beholdes alltid
3. **Delete:** untagged versjoner eldre enn 7 dager slettes

Apply:
```bash
gcloud artifacts repositories set-cleanup-policies cloud-run-source-deploy \
  --location=europe-north1 \
  --project=evenero \
  --policy=ops/storage/artifact-cleanup.json \
  --no-dry-run
```

Test først med `--dry-run` for å se hvilke filer som ville bli slettet
(synlig i konsollen → Artifact Registry → Cleanup Policies → Dry Run Results).

## cloudbuild-lifecycle.json

Lifecycle på `gs://evenero_cloudbuild/` (Cloud Build kildekode-arkiver).
Bucket vokste til 15 GB med ubegrenset retention. Ny policy: slett objekter
eldre enn 90 dager.

Cloud Build genererer disse arkivene selv ved hvert bygg fra source repo
— vi trenger dem ikke for historisk. Git har koden.

Apply:
```bash
gcloud storage buckets update gs://evenero_cloudbuild/ \
  --lifecycle-file=ops/storage/cloudbuild-lifecycle.json
```

Verifiser:
```bash
gsutil lifecycle get gs://evenero_cloudbuild/
```

## Kost-impact

- Artifact Registry: ~$2.50/mnd før, ~$0.30/mnd etter cleanup-policy stabiliserer seg
- Cloud Build bucket: ~$0.30/mnd før (15 GB), <$0.10/mnd etter
