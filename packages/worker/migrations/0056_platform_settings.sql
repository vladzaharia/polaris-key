-- A-13 (notes/S-13 §6): the platform settings store. Instance-wide, product-less runtime values
-- for the few deploy settings that are safe to edit from the console: today the four background
-- job knobs `LAZY_DELTAS`, `LAZY_DELTA_MAX_BYTES`, `BLOB_GC_MODE` and `BLOB_GC_GRACE_DAYS`.
--
-- The typed registry `PLATFORM_SETTINGS` (`src/core/platformSettings.ts`) is the ONLY list of
-- editable keys: a row whose key is not in it is ignored, and a row whose value fails the
-- registry's validator is never applied (the resolver falls through to the `[vars]` value or the
-- code default). No secret, origin, privilege root, identity provider, key material, session
-- length or rate limit can be declared there (a deny-list test enforces it), so `value_json` never
-- holds one.
--
-- `version` starts at 1 and every write is `expectedVersion`-guarded (409 on a mismatch);
-- `updated_by` is the verified admin session's subject. Every write also appends a
-- `platform_audit` row with the value before and after. Read by both Worker scripts (the request
-- Worker and the lazy-delta consumer) through a 30-second per-isolate cache. Core-owned
-- (`TABLE_OWNERS.core`).
CREATE TABLE IF NOT EXISTS platform_settings (
  key         TEXT PRIMARY KEY,
  value_json  TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT NOT NULL
);
