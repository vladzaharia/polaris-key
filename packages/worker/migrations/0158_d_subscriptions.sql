-- LX-41.2: the subscriptions table (plans/LX-41.md §6.1). One live subscription per target (a
-- licence or a grant); a subscription moves its target's `expires_at`. Written only through
-- core/licensing/subscriptions.ts (LX-41.9); nothing reads it yet. Replay-safe.
-- The source and status vocabularies are replaceable triggers (the 0105_m precedent).
-- Provisional number. Rollback: scripts/rollback/0154_durations.down.sql (report-only).
CREATE TABLE IF NOT EXISTS subscriptions (
  product            TEXT NOT NULL REFERENCES products(slug),
  id                 TEXT NOT NULL,
  license_id         TEXT NULL,
  grant_id           TEXT NULL,
  source             TEXT NOT NULL,
  external_ref_hash  TEXT NULL,
  status             TEXT NOT NULL,
  period             TEXT NOT NULL,
  current_period_end INTEGER NOT NULL,
  created_at         INTEGER NOT NULL,
  modified_at        INTEGER NOT NULL,
  modified_by        TEXT NOT NULL,
  PRIMARY KEY (product, id),
  CHECK ((license_id IS NOT NULL) + (grant_id IS NOT NULL) = 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_ref
  ON subscriptions(product, source, external_ref_hash) WHERE external_ref_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_license_live
  ON subscriptions(product, license_id) WHERE license_id IS NOT NULL AND status <> 'expired';
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_grant_live
  ON subscriptions(product, grant_id) WHERE grant_id IS NOT NULL AND status <> 'expired';
CREATE INDEX IF NOT EXISTS idx_subscriptions_due
  ON subscriptions(product, status, current_period_end);

CREATE TRIGGER IF NOT EXISTS trg_subscriptions_source_ins
BEFORE INSERT ON subscriptions
WHEN NEW.source NOT IN ('manual', 'external', 'app-store', 'play', 'polaris-key')
BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: subscriptions.source'); END;

CREATE TRIGGER IF NOT EXISTS trg_subscriptions_source_upd
BEFORE UPDATE OF source ON subscriptions
WHEN NEW.source NOT IN ('manual', 'external', 'app-store', 'play', 'polaris-key')
BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: subscriptions.source'); END;

CREATE TRIGGER IF NOT EXISTS trg_subscriptions_status_ins
BEFORE INSERT ON subscriptions
WHEN NEW.status NOT IN ('trialing', 'active', 'past_due', 'canceled', 'expired')
BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: subscriptions.status'); END;

CREATE TRIGGER IF NOT EXISTS trg_subscriptions_status_upd
BEFORE UPDATE OF status ON subscriptions
WHEN NEW.status NOT IN ('trialing', 'active', 'past_due', 'canceled', 'expired')
BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: subscriptions.status'); END;
