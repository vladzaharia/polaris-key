-- P2-01 — the Core blob store's bookkeeping (src/core/blobs.ts).
--
-- The bytes live in R2 (env.BLOBS), content-addressed under blobs/, bundles/, deltas/ and
-- gated/. D1 records which of those objects exist and which product references each, so:
--   * "is this object already stored?" is one indexed lookup, not an R2 round trip — P2-02's
--     upload tickets ask it for thousands of pack file blobs at once (P4-03);
--   * a byte route serves a key only if THIS product holds a ref to it (hasRef);
--   * P4-14's collector deletes only objects with no ref, and the foreign key below refuses to
--     delete an object that still has one.
--
-- Idempotent on replay (0012/0018 conventions): IF NOT EXISTS throughout, no ALTER.

-- One row per verified object under a locked prefix. Written ONLY by promote(), after the
-- staged bytes were verified against the hash the key is named by.
CREATE TABLE IF NOT EXISTS blob_objects (
  storage_key  TEXT PRIMARY KEY,
  sha256       TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  size         INTEGER NOT NULL CHECK (size >= 0),
  kind         TEXT NOT NULL CHECK (kind IN ('blob', 'bundle', 'delta')),
  gated        INTEGER NOT NULL DEFAULT 0 CHECK (gated IN (0, 1)),
  verified_at  INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_blob_objects_sha256 ON blob_objects(sha256);

-- Who references what. P2-04 writes `artifact` refs, P4-02 `pack-object` refs. The object must
-- already be recorded (a ref can never name unverified bytes). No ON DELETE, like every other
-- product-scoped table (R11-01): nothing deletes a product row today, and the shared objects a
-- ref points at are the collector's to reclaim, never a cascade's.
CREATE TABLE IF NOT EXISTS blob_refs (
  product      TEXT NOT NULL REFERENCES products(slug),
  storage_key  TEXT NOT NULL REFERENCES blob_objects(storage_key),
  ref_kind     TEXT NOT NULL,
  ref_id       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (product, storage_key, ref_kind, ref_id)
);

-- The collector's question ("does anything still reference this key?") and the FK check on
-- blob_objects deletes both scan by storage_key alone.
CREATE INDEX IF NOT EXISTS idx_blob_refs_storage_key ON blob_refs(storage_key);
