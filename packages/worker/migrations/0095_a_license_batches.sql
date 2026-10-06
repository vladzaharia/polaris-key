-- LX-28 (notes/S-24 §5.6, §6.1, §7.1, §7.3, D10): bulk floating keys.
--
-- An operator creates up to 500 floating licences in one labelled batch (resellers, bundles,
-- store key pools), receives their keys ONCE in the create answer, can find the batch again with
-- how many of its keys were used, and can disable every unused key of a batch that leaked
-- (`POST …/license/batches/<id>/disable-unused`). One row here per batch; each licence of the
-- batch names it in `licenses.batch_id` (0095_b).
--
--   product     the product slug; first in the primary key, like every product-scoped table
--   id          `batch_` and 12 random base64url characters
--   label       the operator's label, 1 to 80 characters, NOT unique ("Steam keys, October")
--   count       how many licences the batch created (fixed at creation; a later licence deletion
--               does not change it)
--   tier_id     the tier every licence of the batch was created with
--   created_by  the operator's session subject, and nothing else about a person (S-24 §7.3)
--   created_at  epoch seconds
--
-- No key, hash or anything derived from a key is stored here: the keys live only as peppered
-- hashes in `keys_index`, like every other key, and the Worker can never answer them again.
--
-- Owner (TABLE_OWNERS in packages/docs/scripts/gen-reference.mjs): License. Expand-only; every
-- statement is `IF NOT EXISTS`, so a replay converges (R11-04).
CREATE TABLE IF NOT EXISTS license_batches (
  product    TEXT NOT NULL,
  id         TEXT NOT NULL,
  label      TEXT NOT NULL,
  count      INTEGER NOT NULL CHECK (count > 0),
  tier_id    TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (product, id)
);
-- The batch list reads newest first.
CREATE INDEX IF NOT EXISTS idx_license_batches_created
  ON license_batches(product, created_at);
