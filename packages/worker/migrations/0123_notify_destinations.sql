-- ST-27: where operator alerts go (core/notify/alertDestinations.ts).
--
-- One row per destination. `product` is '_platform' for the platform's destinations (a value no
-- product slug can spell) or a product's slug for that product's override. A product's override
-- replaces the platform's for the alert kinds it subscribes to; with none, the platform's apply.
--
--   kind         'email' (a recipient address, mailed through Core's one send choke point) or
--                'webhook' (an https URL, signed with the destination's own secret);
--   target       the address or the URL, as normalised on write. A URL never carries userinfo or
--                a secret in its path by our rules, but it is still not shown in audit rows:
--                audit holds the host only;
--   alerts_json  the alert kinds this destination takes, a JSON array of strings;
--   version      optimistic concurrency, +1 on every write;
--   last_status  the last delivery outcome ('ok' | 'failed' | 'refused'); failures counts the
--                run of failures since the last 'ok' and is capped by the writer.
--
-- The webhook signing secret lives in its own table, sealed under PLATFORM_KEK (AAD
-- `pkey:v2:<product>:notify-destination:<id>`), so a read of the destinations never touches it
-- and the KEK sweep re-seals it with the other sealed tables. It is never read back to a caller.
--
-- `product` leads the primary key like every product-scoped table (test/attack/R11-data.test.ts).
--
-- Expand-only. Core owns both tables (`TABLE_OWNERS.core`). Down: scripts/rollback/0123_notify_destinations.down.sql.
-- The `CREATE TABLE` keeps one column per line and closes on its own line: the docs data-model
-- generator parses this file literally.

CREATE TABLE IF NOT EXISTS notify_destinations (
  product TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('email', 'webhook')),
  target TEXT NOT NULL,
  label TEXT,
  alerts_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  last_status TEXT,
  last_at INTEGER,
  failures INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (product, id)
);

CREATE TABLE IF NOT EXISTS notify_destination_secrets (
  product TEXT NOT NULL,
  destination_id TEXT NOT NULL,
  enc_secret_json TEXT NOT NULL,
  PRIMARY KEY (product, destination_id)
);
