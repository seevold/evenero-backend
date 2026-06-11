-- Migration: per-valuta prisbok på print_products.
--
-- NOK forblir i qty_variants (uendret — NOK-flyten røres ikke). Nye valutaer
-- (SEK/DKK/EUR + evt. flere senere) lagres i prices_by_currency, keyet på
-- ISO-valutakode → qty → { retail_minor, margin_pct }.
--
-- Eksempel:
--   prices_by_currency = {
--     "SEK": { "1": {"retail_minor": 39900, "margin_pct": 62.1}, "3": {...} },
--     "EUR": { "1": {"retail_minor": 3500,  "margin_pct": 60.4}, ... },
--     "DKK": { ... }
--   }
--
-- Seed fyller dette ved å quote Gelato i hver valuta + markup (per-valuta
-- pretty-rounding). Catalog/quote/checkout resolver valuta fra land og leser
-- riktig pris herfra (NOK leses fortsatt fra qty_variants).
--
-- Kjøres MANUELT mot staging-DB og prod-DB FØR kode-deploy. Default tom {} —
-- til seed har kjørt faller alt tilbake til NOK (ikke-brytende).

BEGIN;

ALTER TABLE print_products
  ADD COLUMN IF NOT EXISTS prices_by_currency JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMIT;
