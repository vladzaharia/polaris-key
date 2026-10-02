-- P4-02 — pack deliverables: pins, an app release's contentApi, each build's embedded packs
-- (plans/P4-01.md §6, decision 24).
--
-- Pack releases need no new release table: a pack release is a `release_metadata` row of its pack
-- deliverable (`deliverable_id`, `seq`), one `release_builds` row per variant (`build_id` the
-- variant key, `default` for none; `platform` NULL, `format` the pack type), one
-- `release_artifacts` row per object its record names (roles `payload`, `files-index`,
-- `files-gaps`, `delta`, `patch`, `patch-data`: `release_artifacts.role` has no CHECK, 0027_f),
-- and its CI-signed record in `release_records` (0044, `kind = 'pack'`). Pack declarations are
-- `release_deliverables` rows of kind `pack` (0027_a), written by resync. File blobs earn
-- `blob_refs` of kind `pack-upload` (`ref_kind` is free text).

-- `release_pins` — Release's. Which pack release each app release pins: a MIRROR of the signed
-- `content.pins` of the app release's record (or descriptor), written in the ingest batch and
-- never edited afterwards. `record_sha256` is the pinned pack record's hash (the pin's
-- `release.sha256`); `required` and `delivery` are the app release's `expects` entry for the pack.
-- A yank of the pinned pack release stops new pins and leaves these rows alone (CONTENT §6.7).
CREATE TABLE IF NOT EXISTS release_pins (
  product           TEXT NOT NULL REFERENCES products(slug),
  app_release_id    TEXT NOT NULL,
  pack_deliverable  TEXT NOT NULL,
  pack_release_id   TEXT NOT NULL,
  record_sha256     TEXT NOT NULL,
  required          INTEGER NOT NULL,
  delivery          TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (product, app_release_id, pack_deliverable),
  FOREIGN KEY (product, app_release_id) REFERENCES release_metadata(product, release_id),
  FOREIGN KEY (product, pack_release_id) REFERENCES release_metadata(product, release_id),
  CHECK (required IN (0, 1))
);

-- "Which app releases pin pack release X" (the hook's `pinnedBy`, P4-09, P4-14).
CREATE INDEX IF NOT EXISTS idx_release_pins_pack
  ON release_pins(product, pack_release_id);

-- The `content.contentApi` of an app release (NULL for a pack release, or an app release published
-- before its product declared packs). P4-12 resolves compatible packs by it.
ALTER TABLE release_metadata ADD COLUMN content_api INTEGER;

-- A build's `embeds` (the packs it ships embedded), as a JSON array of pack ids; NULL when the
-- descriptor omits it.
ALTER TABLE release_builds ADD COLUMN embeds_json TEXT;
