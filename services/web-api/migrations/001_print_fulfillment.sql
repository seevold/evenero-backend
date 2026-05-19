-- Migration: print-on-demand (Gelato) tabeller
-- Kjøres MANUELT som DB-owner mot evenero-db-staging FØR kode-deploy.
-- Prod-kjøring (mot evenero-db-1) gjøres separat ved cutover av feature.

BEGIN;

-- ────────────────────────────────────────────────────────────────────────
-- print_categories
-- ────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS print_categories (
  slug              TEXT PRIMARY KEY,
  format_family     TEXT NOT NULL,
  presentation_mode TEXT NOT NULL,
  display_name      JSONB NOT NULL,
  display_order     INTEGER NOT NULL DEFAULT 100,
  active            BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────────────
-- print_products
-- ────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS print_products (
  slug                      TEXT PRIMARY KEY,
  category_slug             TEXT NOT NULL,
  product_type              TEXT NOT NULL DEFAULT 'qr_template',
  display_name              JSONB NOT NULL,
  width_mm                  INTEGER NOT NULL,
  height_mm                 INTEGER NOT NULL,
  default_gelato_uid        TEXT NOT NULL,
  qty_variants              JSONB NOT NULL,
  express_surcharge_minor   INTEGER NOT NULL DEFAULT 5000,
  markup_target_pct         NUMERIC(5,2) NOT NULL DEFAULT 60,
  allowed_countries         TEXT[],
  related_product_slugs     TEXT[],
  pdf_renderer              TEXT NOT NULL DEFAULT 'qr_simple',
  metadata                  JSONB,
  last_price_refresh_at     TIMESTAMP,
  active                    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at                TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_print_products_category ON print_products(category_slug);
CREATE INDEX IF NOT EXISTS idx_print_products_active   ON print_products(active);

-- ────────────────────────────────────────────────────────────────────────
-- print_orders
-- ────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS print_orders (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number                TEXT NOT NULL UNIQUE,
  user_id                     UUID,
  customer_email              TEXT NOT NULL,
  status                      TEXT NOT NULL DEFAULT 'pending',

  stripe_session_id           TEXT UNIQUE,
  stripe_payment_intent_id    TEXT,

  gelato_order_id             TEXT,
  gelato_order_reference_id   TEXT UNIQUE,

  total_minor                 INTEGER NOT NULL,
  shipping_minor              INTEGER NOT NULL DEFAULT 0,
  tax_minor                   INTEGER NOT NULL DEFAULT 0,
  currency                    TEXT NOT NULL,

  shipping_address            JSONB NOT NULL,
  shipping_method_uid         TEXT,
  shipping_method_name        TEXT,
  tracking_url                TEXT,
  tracking_code               TEXT,
  carrier                     TEXT,

  paid_at                     TIMESTAMP,
  submitted_at                TIMESTAMP,
  shipped_at                  TIMESTAMP,
  delivered_at                TIMESTAMP,

  failure_reason              TEXT,
  lasse_notified_at           TIMESTAMP,
  submit_attempts             INTEGER NOT NULL DEFAULT 0,

  created_at                  TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_print_orders_status  ON print_orders(status);
CREATE INDEX IF NOT EXISTS idx_print_orders_email   ON print_orders(customer_email);
CREATE INDEX IF NOT EXISTS idx_print_orders_created ON print_orders(created_at);

-- ────────────────────────────────────────────────────────────────────────
-- print_order_items
-- ────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS print_order_items (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id                    UUID NOT NULL REFERENCES print_orders(id) ON DELETE CASCADE,
  product_slug                TEXT NOT NULL,
  gelato_product_uid          TEXT NOT NULL,
  gelato_item_reference_id    TEXT NOT NULL,
  quantity                    INTEGER NOT NULL,
  unit_price_minor            INTEGER NOT NULL,
  line_total_minor            INTEGER NOT NULL,
  source_event_id             TEXT,
  source_template_key         TEXT,
  design_choice               TEXT NOT NULL,
  print_file_url              TEXT,
  print_file_generated_at     TIMESTAMP,
  created_at                  TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_print_order_items_order ON print_order_items(order_id);

-- ────────────────────────────────────────────────────────────────────────
-- print_gelato_webhook_events
-- ────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS print_gelato_webhook_events (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_reference_id  TEXT,
  event_type          TEXT NOT NULL,
  payload             JSONB NOT NULL,
  signature_valid     BOOLEAN NOT NULL,
  received_at         TIMESTAMP NOT NULL DEFAULT NOW(),
  processed_at        TIMESTAMP,
  processing_error    TEXT
);

CREATE INDEX IF NOT EXISTS idx_print_webhook_order_ref ON print_gelato_webhook_events(order_reference_id);
CREATE INDEX IF NOT EXISTS idx_print_webhook_received  ON print_gelato_webhook_events(received_at);

-- ────────────────────────────────────────────────────────────────────────
-- Grant til application-roller (Replit_app er legacy, behold for cutover-fasen)
-- ────────────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON
  print_categories, print_products, print_orders, print_order_items, print_gelato_webhook_events
TO PUBLIC;

COMMIT;
