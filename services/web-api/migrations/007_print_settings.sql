-- Migration: runtime-konfig for print-tjenesten (admin-styrt, ikke env-var).
--
-- Én-rads tabell (id alltid = 1). Lar superuser slå tjenesten av/på og styre
-- hvilke land som selger — uten redeploy. Backend leser denne i catalog/quote/
-- checkout som hard gate.
--
-- service_enabled:   master av/på. false → ingen nye ordre godtas.
-- enabled_countries: ISO-2-land som faktisk selger. Snittet med systemets
--                    støttede liste (ALLOWED_COUNTRIES_V1) + per-produkt
--                    allowed_countries gir endelig tilgjengelighet.
--
-- Default: service PÅ + alle 21 nåværende støttede land (ikke-brytende — bevarer
-- dagens oppførsel). Superuser kan deretter deaktivere land/tjeneste fra admin.
--
-- Kjøres MANUELT mot staging-DB og prod-DB FØR kode-deploy.

BEGIN;

CREATE TABLE IF NOT EXISTS print_settings (
  id                 INTEGER PRIMARY KEY DEFAULT 1,
  service_enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  enabled_countries  TEXT[]  NOT NULL DEFAULT '{}',
  updated_at         TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_by         TEXT,
  CONSTRAINT print_settings_single_row CHECK (id = 1)
);

-- Seed enkelt-raden hvis den ikke finnes. Alle 21 støttede land aktivert.
INSERT INTO print_settings (id, service_enabled, enabled_countries)
VALUES (1, TRUE, ARRAY[
  'NO','SE','DK','FI','IS',
  'DE','FR','NL','BE','AT','IE','ES','IT','PT','PL','CH',
  'GB','US','CA','AU','NZ'
])
ON CONFLICT (id) DO NOTHING;

GRANT SELECT, INSERT, UPDATE ON print_settings TO PUBLIC;

COMMIT;
