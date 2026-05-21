-- 004 — Rename the "Postcard" category to "Flyer".
-- The category represents a print SIZE/format (A6/A5), not literally
-- postcards. Slugs ("postcard", "postcard_a6", "postcard_a5") are kept
-- unchanged so existing orders and code keep working — only the
-- customer-facing display_name JSONB changes.
--
-- Apply manually against the target DB before deploying. Idempotent.

UPDATE print_categories
SET display_name = '{"no":"Flyer","en":"Flyers","sv":"Flygblad","es":"Folletos"}'::jsonb,
    updated_at = NOW()
WHERE slug = 'postcard';

UPDATE print_products
SET display_name = '{"no":"Flyer A6","en":"A6 flyer","sv":"A6-flygblad","es":"Folleto A6"}'::jsonb,
    updated_at = NOW()
WHERE slug = 'postcard_a6';

UPDATE print_products
SET display_name = '{"no":"Flyer A5","en":"A5 flyer","sv":"A5-flygblad","es":"Folleto A5"}'::jsonb,
    updated_at = NOW()
WHERE slug = 'postcard_a5';
