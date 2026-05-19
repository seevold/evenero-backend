-- Migration 003: legg til pack_size, allow_custom_qty, product_info kolonner
-- på print_products. Kjøres MANUELT mot evenero-db-staging FØR re-seed.

BEGIN;

ALTER TABLE print_products
  ADD COLUMN IF NOT EXISTS pack_size INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS allow_custom_qty BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS product_info JSONB;

COMMIT;
