-- Polaris Key v1 hardening.
-- Adds soft-deletion, device metadata, artifact policy, and signing-key lifecycle helpers
-- without rewriting existing rows.
--
-- R11-04: every idempotent statement (`CREATE ... IF NOT EXISTS`) comes FIRST and the
-- non-idempotent `ALTER TABLE ... ADD COLUMN`s come last, so a replay that dies on a duplicate
-- column can no longer strand the indexes behind it. 0012_replay_guard.sql re-asserts these
-- two indexes anyway, because a partial apply of THIS file is exactly how they go missing.

-- Exactly one signing key may sign for a product. Staged and retired keys can still verify.
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_keys_one_active
  ON product_keys(product)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_product_keys_verify
  ON product_keys(product, status, created_at);

ALTER TABLE products ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE products ADD COLUMN deleted_at INTEGER;

ALTER TABLE release_config ADD COLUMN artifact_policy_json TEXT;
