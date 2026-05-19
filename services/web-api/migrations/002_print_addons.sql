-- Migration 002: legg til addons-støtte på print_products.
-- Kjøres MANUELT mot evenero-db-staging FØR ny seed-kjøring.

BEGIN;

-- addons:
--   [{ slug, label_no, label_en, description_no, description_en,
--      gelato_uid_override?, surcharge_minor, default?: bool }]
-- Hvis gelato_uid_override er satt: bruk denne SKU-en når addon er valgt
-- (overstyrer både default_gelato_uid og qty_variants[i].gelato_uid).
-- surcharge_minor: legges til retail per ordre.
ALTER TABLE print_products
  ADD COLUMN IF NOT EXISTS addons JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMIT;
