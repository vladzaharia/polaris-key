-- UX-15 (docs/design/EXPERIENCE.md §0.9, journey O1): the refusal log.
--
-- `core/authz.ts` refuses an activation (seat limit, hardware mismatch, missing fingerprint, an
-- unusable licence) and, until now, stored nothing about it: the console could say "3 of 3
-- devices" but never "Mara tried to activate Studio Laptop 4 min ago". One row per refusal, written
-- off the response path (`ServiceContext.waitUntil`) by `core/refusals.ts`, so a refused device
-- never waits on this table and a failed write never changes the answer it gets.
--
--   product       the product slug (every read and the prune name one product)
--   license_id    the licence the activation was refused against
--   at            epoch seconds
--   reason        `device_limit` | `hardware_mismatch` | `fingerprint_required` |
--                 `license_unusable` (validated in `core/refusals.ts`, not by a CHECK, so a new
--                 reason needs no table rebuild)
--   device_label  display text: the device's own name when it has one, else its reported platform
--                 and architecture, else its User-Agent. Customer-influenced, so it is held to
--                 plain text and at most 64 characters before it is written (THREAT-MODEL.md)
--   device_hash   SHA-256 (hex, first 32 characters) of the device id: groups repeat attempts from
--                 one device without copying the raw id into a second table
--
-- Retention: 30 days (`REFUSAL_RETENTION_SECONDS`), pruned per product by the nightly sweep
-- (`scheduled.ts`). Repeat refusals of the same device for the same reason within a minute are
-- folded into one row at write time, so a client retrying in a loop cannot grow the table faster
-- than one row per device per reason per minute.
--
-- Indexes: `(product, at)` serves the product-wide read (the Refusing devices facet, the refusal
-- spike rate) and the prune; `(product, license_id, at)` serves the per-licence read (the Status
-- health line and Recent).
--
-- Expand-only: a new table no older Worker names.
--
-- Rollback: a pre-UX-15 Worker never reads or writes the table, so no SQL is needed. To drop it
-- anyway:
--   DROP TABLE license_refusals;

CREATE TABLE IF NOT EXISTS license_refusals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  product      TEXT NOT NULL REFERENCES products(slug),
  license_id   TEXT NOT NULL,
  at           INTEGER NOT NULL,
  reason       TEXT NOT NULL,
  device_label TEXT,
  device_hash  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_license_refusals_product_at
  ON license_refusals(product, at);
CREATE INDEX IF NOT EXISTS idx_license_refusals_license_at
  ON license_refusals(product, license_id, at);
