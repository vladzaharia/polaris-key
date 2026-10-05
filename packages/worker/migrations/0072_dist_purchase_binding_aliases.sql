-- LX-03 (notes/S-19 §4.3 G6, §9): a merged-away licence's purchase binding keeps resolving.
--
-- `dist_purchase_bindings` holds one binding UUID per licence, handed to the store before a
-- purchase (Apple `appAccountToken`, Play `obfuscatedAccountId`, the Steam ticket identity). When
-- an identity sign-in migrates an anonymous enrolled licence into the identity's licence
-- (`services/identity/oidc.ts`, `activateFromIdentity`), every purchase already made carries the
-- OLD licence's binding, and so does every purchase the old device made but has not yet restored.
-- The binding row cannot simply be re-pointed: its key is (product, license_id), and the target
-- licence may already hold a binding of its own.
--
-- `dist_purchase_binding_aliases` — one row per binding that now resolves to another licence than
-- the one it was issued to. `licenseOfBinding` (`services/distribution/commerce/state.ts`) reads
-- it BEFORE `dist_purchase_bindings`, so a restore that names the old binding reaches the target
-- licence. `from_license_id` is the licence the binding was issued to (its row in
-- `dist_purchase_bindings` is kept, never deleted). A later merge of the target re-points every
-- alias naming it, so a chain of merges resolves in one read. Written only by Distribution's
-- `licenseMerge` statements (`core/licenseMerge.ts`); LX-11 replaces aliases with holder bindings.
--
-- Expand-only: a new table. A Worker deployed before this migration never names it.
--
-- Rollback: a pre-LX-03 Worker ignores the table. To drop it anyway:
--   DROP TABLE dist_purchase_binding_aliases;
CREATE TABLE IF NOT EXISTS dist_purchase_binding_aliases (
  product         TEXT NOT NULL REFERENCES products(slug),
  binding_id      TEXT NOT NULL,
  license_id      TEXT NOT NULL,
  from_license_id TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (product, binding_id)
);

CREATE INDEX IF NOT EXISTS idx_dist_purchase_binding_aliases_license
  ON dist_purchase_binding_aliases (product, license_id);
