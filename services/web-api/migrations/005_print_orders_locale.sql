-- Migration: lagre kundens locale OG app-base-URL på print_orders så vi kan
-- sende statusmails (shipped, delivered, etc.) på riktig språk OG bygge
-- riktig status-side-lenke uten å ha Stripe-session-konteksten tilgjengelig
-- når Gelato-webhook fyrer av.
--
-- app_base_url er FE-tilstanden (origin) på tidspunktet kunden gjorde checkout
-- — feks staging-app.evenero.com vs event.evenero.com. Lagres bevisst per
-- ordre fremfor å lese env-var: unngår at staging-shipped-mail får prod-URL
-- (fail-fast-regel i CLAUDE.md).
--
-- Kjøres MANUELT mot staging-DB og prod-DB FØR kode-deploy.
-- Default for eksisterende rader: 'en' / tom URL (pre-feature, ingen impact).

BEGIN;

ALTER TABLE print_orders
  ADD COLUMN IF NOT EXISTS locale TEXT NOT NULL DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS app_base_url TEXT NOT NULL DEFAULT '';

COMMIT;
