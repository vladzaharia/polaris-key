-- A-18a (notes/S-15 §6.3): the store operation ledger gains `plane`, where a step ran. One bare
-- ALTER and nothing after it (0018_index_assertion.sql: SQLite has no ADD COLUMN IF NOT EXISTS).
--
--   plane   'worker'    a Worker-plane write through the gate (`core/storefront/ledger.ts`
--                       `performStoreWrite`); every row A-17 wrote, hence the default
--           'ci'        a CI-plane step, written by the publish action's report-back (A-18h)
--           'pr'        a PR-plane step (a winget, Homebrew, Scoop or Flathub pull request, A-18i)
--           'deep-link' a step the operator did in the store's own console, recorded by its
--                       verifier (A-18j)
--
-- `op_id` gains the store as its first component from A-18a on
-- (`sha256(JSON [store, scope, product, op, natural_key, idempotency key])`); rows written before
-- keep their ids, and a replay of such an intent re-reads its natural key before sending anything.
ALTER TABLE store_operations ADD COLUMN plane TEXT NOT NULL DEFAULT 'worker'
  CHECK (plane IN ('worker', 'ci', 'pr', 'deep-link'));
