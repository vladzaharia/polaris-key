-- P4-12 — compatible and standalone packs: resolved pack sets, mirrored holds, pack floors per
-- contentApi line, and each app release's packChannels mapping (CONTENT §6.3, §6.9; README §3.4).
-- Two files, one bare ALTER each and nothing after it (0018_index_assertion.sql): this one
-- creates the three tables and adds `release_metadata.pack_channels_json` LAST; 0046_b adds
-- `release_builds.conflicts_json`.
--
-- Every table is keyed by deliverable, never by "is a pack" (README §11 decision 1 guardrail).

-- `release_sets` — Release's. One resolved pack set per selector (channel, app deliverable, live
-- contentApi level, platform, variant key), over the `compatible` and `standalone` packs only:
-- `pinned` packs never enter a set (they are in the app's own signed record). Rewritten whole, in
-- one batch, on every publish, pointer move, floor change and yank (`services/release/packs/
-- sets.ts`), so a reader never sees half a resolution. `pack_set_id` is client-core's `packSetId`
-- over the set's (pack id, record hash) pairs: identical sets share it. `set_json` holds the
-- chosen releases; `unsatisfied_json` the packs no release satisfies at this selector, each with
-- a reason (`content-floor`, `dependency`, …), NULL when every pack resolved. P4-13 freezes the
-- wire form of both.
CREATE TABLE IF NOT EXISTS release_sets (
  product           TEXT NOT NULL REFERENCES products(slug),
  channel           TEXT NOT NULL,
  app_deliverable   TEXT NOT NULL,
  content_api       INTEGER NOT NULL,
  platform          TEXT NOT NULL,
  variant           TEXT NOT NULL,
  pack_set_id       TEXT NOT NULL,
  set_json          TEXT NOT NULL,
  unsatisfied_json  TEXT,
  resolved_at       INTEGER NOT NULL,
  PRIMARY KEY (product, channel, app_deliverable, content_api, platform, variant)
);

-- `release_holds` — Release's. An app release keeping a `compatible` pack at one release: a
-- MIRROR of the signed `content.holds` of the app release's record (or descriptor), written in
-- the ingest batch beside `release_pins` and never edited afterwards. Devices apply holds over
-- the feed's set as they apply pins (P4-13); the server checks them at publish and keeps the
-- held releases live for GC (P4-14).
CREATE TABLE IF NOT EXISTS release_holds (
  product           TEXT NOT NULL REFERENCES products(slug),
  app_release_id    TEXT NOT NULL,
  pack_deliverable  TEXT NOT NULL,
  pack_release_id   TEXT NOT NULL,
  record_sha256     TEXT NOT NULL,
  reason            TEXT,
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (product, app_release_id, pack_deliverable),
  FOREIGN KEY (product, app_release_id) REFERENCES release_metadata(product, release_id),
  FOREIGN KEY (product, pack_release_id) REFERENCES release_metadata(product, release_id)
);

-- "Which app releases hold pack release X" (GC's live references, P4-14).
CREATE INDEX IF NOT EXISTS idx_release_holds_pack
  ON release_holds(product, pack_release_id);

-- `release_pack_floors` — Release's. A pack floor per contentApi line (CONTENT §6.7 item 3):
-- "foes ≥ 1.3.4 for contentApi 3", so a fix is backported to an older content line. Operator-
-- owned (`source` is `admin`; a resync never writes it). A level-independent floor stays
-- `release_channel_policy.min_supported` of the pack's row; resolution applies both. A separate
-- table rather than a `content_api` column on `release_channel_policy`, whose primary key is
-- (product, deliverable_id, channel) and whose every reader and upsert keys on that triple.
CREATE TABLE IF NOT EXISTS release_pack_floors (
  product         TEXT NOT NULL REFERENCES products(slug),
  deliverable_id  TEXT NOT NULL,
  channel         TEXT NOT NULL,
  content_api     INTEGER NOT NULL,
  min_version     TEXT NOT NULL,
  source          TEXT NOT NULL DEFAULT 'admin',
  created_at      INTEGER NOT NULL,
  modified_at     INTEGER NOT NULL,
  modified_by     TEXT,
  PRIMARY KEY (product, deliverable_id, channel, content_api),
  FOREIGN KEY (product, deliverable_id) REFERENCES release_deliverables(product, deliverable_id),
  CHECK (content_api >= 1),
  CHECK (source IN ('manifest', 'admin'))
);

-- The `content.packChannels` of an app release (a JSON object, pack id or `prefix.*` → channel),
-- NULL when the release carries none. Resolution reads it; an app publish refuses a mapping that
-- differs from another live app release's on the same channel and contentApi.
ALTER TABLE release_metadata ADD COLUMN pack_channels_json TEXT;
