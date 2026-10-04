-- F-03 (plans/F-01.md §6.3, §6.4): the system product. `products.system = 1` marks the one
-- product the platform owns, `polaris-key` (`SYSTEM_PRODUCT_SLUG` in @polaris-key/manifest), which
-- owns the platform packages on the package feeds. Only `ensureSystemProduct` (the platform action
-- `POST /manage/api/platform/feeds/bootstrap`) sets it; a manual create refuses the slug, and
-- delete and rename refuse a row that has it. 0 for every existing product.
--
-- A bare ALTER, alone in its file and last (0013/0020 rule): SQLite has no ADD COLUMN IF NOT
-- EXISTS, so a replay fails here and nowhere earlier.
ALTER TABLE products ADD COLUMN system INTEGER NOT NULL DEFAULT 0;
