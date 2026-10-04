-- A-12 (notes/S-13 §6.1): the product-less audit trail. `audit.product` is NOT NULL REFERENCES
-- products (0001_init), so an action on the platform as a whole (the KEK re-seal sweep today, the
-- platform settings store in A-13) had nowhere to be recorded except one row per product it
-- happened to touch. This is `audit`'s platform twin: no product column at all.
--
-- Written only through `platformAudit()` (`src/admin/audit.ts`): the actor comes from the
-- VERIFIED admin session, `at` is server time. `before_json` / `after_json` hold the value before
-- and after the change, as JSON; a writer must never put a secret in them (the A-13 registry holds
-- no secret, and the KEK sweep records counts, never key material). Read by
-- `GET /manage/api/platform/activity`, keyset-paginated on (at DESC, id DESC); pruned past the
-- same 180-day retention as `audit` by the nightly sweep (`scheduled.ts`, `platformAudit`).
-- Core-owned (`TABLE_OWNERS.core`).
CREATE TABLE IF NOT EXISTS platform_audit (
  id          TEXT PRIMARY KEY,
  at          INTEGER NOT NULL,
  actor_sub   TEXT,
  actor_name  TEXT,
  actor_email TEXT,
  action      TEXT NOT NULL,
  target_kind TEXT,
  target_id   TEXT,
  summary     TEXT,
  before_json TEXT,
  after_json  TEXT
);
CREATE INDEX IF NOT EXISTS idx_platform_audit_at ON platform_audit(at DESC, id DESC);
