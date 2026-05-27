-- Migration: lagre liste av pakker (shipments) på print_orders.
-- Gelato splitter ofte én ordre i flere pakker når items printes i ulike
-- fabrikker (eks. plakater + kort). Hver pakke får eget tracking-nr.
--
-- Tidligere lagret vi kun ETT tracking_url/code/carrier-felt — det er
-- bevart for bakoverkompatibilitet (speilet fra første pakke), men
-- shipments-arrayet er nå source-of-truth for status-side og mail.
--
-- Schema-eksempel:
--   shipments = [
--     {
--       "trackingCode": "00573132901640270556",
--       "trackingUrl": "https://tracking.postnord.com/se/?id=...",
--       "carrier": "PostNord Norway Service Point",
--       "itemRefs": ["postcard_a6-...", "businesscard_bc-..."],
--       "weight": 319,
--       "packageId": "39a05cc9..."
--     },
--     ...
--   ]
--
-- Kjøres MANUELT mot staging-DB og prod-DB FØR kode-deploy.

BEGIN;

ALTER TABLE print_orders
  ADD COLUMN IF NOT EXISTS shipments JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMIT;
