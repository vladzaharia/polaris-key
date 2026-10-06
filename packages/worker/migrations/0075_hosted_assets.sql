-- HA-01 (notes/S-20 §6.2): hosted assets — Polaris Key's own copy of a developer's file, and the
-- record of where it came from.
--
-- One row per (product, slot, locale). `slot` is the role the copy fills: `presentation.icon`,
-- `listing.header`, `listing.screenshot:<n>`, an A-18 listing slot such as `play:feature-graphic`,
-- `notes-image:<urlhash>` or `release-file` (`core/hostedAssets.ts`, `slotClass`, is the one list).
-- `locale` is `''` for every locale.
--
--   origin        manifest | console | ci | release-mirror — who asked for the copy
--   source_kind   url | repo | upload | ci | github-asset — where the original lives
--   source_ref    the URL, `<path>@<commit>`, or the GitHub asset id; NULL for an upload
--   source_etag   the validator last seen at the source (`If-None-Match` on the next pull)
--   sha256        of the stored original (`blobs/sha256/<sha256>`); NULL while pending, or failed
--                 before any copy existed. A failed or stale row KEEPS its last good sha256, and
--                 that copy keeps serving.
--   content_type  SNIFFED from the bytes (`core/sniff.ts`), never the type a source declared
--   width/height  images only (the Images binding's `.info()`, when bound)
--   variants_json [{w, format, sha256, size}] — the variant ladder (HA-03); `[]` until then
--   status        pending | ready | failed | stale (the source is gone; the last good copy kept)
--   error         the reason code of the last failure: guard:<reason>, status:<n>, too-large,
--                 not-an-image, not-a-video, sha256-mismatch, size-mismatch, timeout, network,
--                 unverifiable, retry, quota
--
-- The bytes are held by `blob_refs` rows with `ref_kind = 'hosted-asset'` and `ref_id =
-- '<slot>@<locale>'` (the original and every variant), written in the same D1 batch as the row; a
-- replaced copy's refs are dropped in that batch, and the collector (P4-14) reclaims the object
-- after the bucket lock and the grace period.
--
-- No CHECK constraints on the enumerations: later HA packages add values (S-20 §6.10, §6.3), and
-- `core/hostedAssets.ts` is the only writer.
--
-- Expand-only: a new table nothing older reads. Rollback: `DROP TABLE hosted_assets;` (the refs
-- it held then fall to the collector like any other unreferenced object).

CREATE TABLE IF NOT EXISTS hosted_assets (
  product       TEXT NOT NULL REFERENCES products(slug),
  slot          TEXT NOT NULL,
  locale        TEXT NOT NULL DEFAULT '',
  origin        TEXT NOT NULL,
  source_kind   TEXT NOT NULL,
  source_ref    TEXT,
  source_etag   TEXT,
  sha256        TEXT,
  size          INTEGER,
  content_type  TEXT,
  width         INTEGER,
  height        INTEGER,
  variants_json TEXT,
  status        TEXT NOT NULL,
  error         TEXT,
  checked_at    INTEGER,
  modified_at   INTEGER NOT NULL,
  PRIMARY KEY (product, slot, locale)
);
