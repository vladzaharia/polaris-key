-- PX-W9 (G21; WIRE-CONTRACT-V4 §12.2, plans/PX-W9.md §6): the key-entry counter.
--
-- One row per counted key entry on a product whose Identity toggle is on: an app activation by key
-- that enrolled a new device (`app`), a browser key session that did (`browser`), and a portal claim
-- whose attach committed (`portal`). Insert-only: a licence's `used` is its row count. Written by
-- `core/keyEntries.ts`; the two device surfaces write in the SAME batch as the seat claim
-- (`repo.ts` `claimDeviceSeat`), so a refused or failed authorisation writes nothing and of
-- concurrent calls from one device only one writes.
--
--   product     the product slug; first in the primary key, like every product-scoped table (R11-05)
--   license_id  the licence whose key was entered
--   id          `ke_` and 12 random base64url characters
--   surface     `app` | `browser` | `portal`
--   device_id   the enrolled device (`browser:<licenseId>` for a browser session); NULL for `portal`
--   created_at  epoch seconds
--
-- The primary key's `(product, license_id)` prefix serves the count. Counting starts at 0 with no
-- backfill (the approved I-09 plan). Licence deletion removes the rows (`core/licenseDelete.ts`);
-- an LX-03 merge leaves them on the retired licence.
--
-- No ON DELETE: like every other product-scoped table, the row references `products(slug)` plainly
-- (R11-01; products are never hard-deleted).
--
-- Expand-only: a new table no older Worker names.
--
-- Rollback: a pre-PX-W9 Worker never reads or writes the table, so no SQL is needed; entries made in
-- that window are simply not counted. To drop it anyway:
--   DROP TABLE license_key_entries;

CREATE TABLE IF NOT EXISTS license_key_entries (
  product     TEXT NOT NULL REFERENCES products(slug),
  license_id  TEXT NOT NULL,
  id          TEXT NOT NULL,
  surface     TEXT NOT NULL CHECK (surface IN ('app','browser','portal')),
  device_id   TEXT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (product, license_id, id),
  CHECK ((surface = 'portal') = (device_id IS NULL))
);
