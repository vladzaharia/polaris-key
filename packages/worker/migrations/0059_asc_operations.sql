-- A-17a (notes/S-14 §7.3, §7.4): the App Store Connect operation ledger. One Core-owned table
-- (`TABLE_OWNERS.core` in the docs generator), written only by `src/core/asc/ledger.ts`.
--
-- Every write A-17 sends to App Store Connect is one row, keyed by
-- `op_id = sha256(JSON [scope, product, op, natural_key, idempotency key])`: the console sends an
-- `Idempotency-Key` per user intent, so a replay with the same key answers the stored result
-- without calling Apple, and a different body under the same key (`request_hash`, a SHA-256 of
-- the canonical request) is refused. Apple has no idempotency mechanism, so a timeout or a 5xx
-- after a POST leaves the row `ambiguous`, and the next attempt re-reads the natural key before
-- sending anything. Multi-step flows (the New-app wizard, Distribute) store their progress as the
-- rows of their steps, so a closed tab or a 429 resumes where it stopped.
--
--   scope           'team' (bundle ids, capabilities: no product) or 'product'
--   product         the product slug for product scope; NULL for team scope (CHECKed)
--   op              the operation, e.g. 'bundle_id.register', 'version.release'
--   natural_key     what the pre-read looks up (an identifier, a version string, a group name)
--   state           pending | done | failed | ambiguous
--   result_ids_json Apple's ids of what the step created or found, e.g. {"bundleId":"HPA5436NK7"}
--   before_json /   Apple's own reads before and after the write, projected through a per-type
--   after_json      allow-list of fields (`core/asc/audit.ts`): never a secret, a password, an
--                   email or a contact field, never a request body or an Apple error body
--   apple_status    the HTTP status of a refused or failed write
--   apple_code      Apple's `errors[].code` (an enum-like token such as
--                   'ENTITY_ERROR.ATTRIBUTE.INVALID'), never free text
--   actor           the admin session's subject (`sub`)
--
-- `created_at` / `finished_at` are epoch seconds. The table is product-less by design for team
-- scope (R11-05's `globalByDesign`); product-scoped reads always filter on `product`. Rows are kept
-- like the audit trails they back; deleting a product leaves its ledger as history.
CREATE TABLE IF NOT EXISTS asc_operations (
  op_id           TEXT PRIMARY KEY,
  scope           TEXT NOT NULL CHECK (scope IN ('team', 'product')),
  product         TEXT,
  op              TEXT NOT NULL,
  natural_key     TEXT NOT NULL,
  state           TEXT NOT NULL
                    CHECK (state IN ('pending', 'done', 'failed', 'ambiguous')),
  request_hash    TEXT NOT NULL,
  result_ids_json TEXT,
  before_json     TEXT,
  after_json      TEXT,
  apple_status    INTEGER,
  apple_code      TEXT,
  actor           TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  finished_at     INTEGER,
  CHECK ((scope = 'team' AND product IS NULL) OR (scope = 'product' AND product IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_asc_operations_product
  ON asc_operations(product, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_asc_operations_natural
  ON asc_operations(scope, product, op, natural_key, created_at DESC);
