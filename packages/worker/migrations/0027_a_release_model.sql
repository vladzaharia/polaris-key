-- P2-03 — release data model v2: deliverables, builds, channel policy, yanks (README §3.4).
--
-- The truth store (0007) indexes every asset by a free-text kind and platform, with no build
-- numbers, no per-platform availability, no yank and no operator-owned channel policy. These four
-- tables are the record the release descriptor (P2-04), the new resolution and policy routes
-- (P2-05), the distribution catalog (P2b-01) and the signed release record (P3) all name.
--
-- Idempotent statements only (CREATE ... IF NOT EXISTS, INSERT ... ON CONFLICT DO NOTHING), so
-- this file replays cleanly (0012/0018 conventions). The six new columns on release_metadata and
-- release_artifacts are bare column additions and so sit in their own files, 0027_b..g, one
-- statement each; the backfill that needs them, and the index changes, are 0027_h; the widened
-- required-index assertion is 0027_i. The lettered siblings share the number the program assigned.
--
-- No CHECK on platform, arch, format or role: those vocabularies grow (P4 adds roles) and a
-- CHECK change is a table rebuild (0016). They are validated in code against the constants
-- @polaris-key/manifest exports (RELEASE_PLATFORMS, RELEASE_ARCHES, ARTIFACT_ROLES,
-- DELIVERABLE_KINDS). `kind` IS checked: app|pack is structural, not a vocabulary.

-- Something a product releases: its `app` (kind app) or a pack (kind pack, with a pack type).
-- `def_json` is the manifest's declaration of it; `def_source` who wrote that declaration.
CREATE TABLE IF NOT EXISTS release_deliverables (
  product         TEXT NOT NULL REFERENCES products(slug),
  deliverable_id  TEXT NOT NULL,
  kind            TEXT NOT NULL,
  pack_type       TEXT,
  def_json        TEXT,
  def_source      TEXT NOT NULL DEFAULT 'manifest',
  created_at      INTEGER NOT NULL,
  modified_at     INTEGER NOT NULL,
  PRIMARY KEY (product, deliverable_id),
  CHECK (kind IN ('app', 'pack'))
);

-- One compiled build of a release for (platform, arch, format), with its build number (iOS
-- CFBundleVersion, Android versionCode, MSIX 4-part, sparkle:version: TEXT, since not all are
-- integers). `build_id` is the artifact-map entry's id (`macos`, `apk`), unique within a release.
-- `platform` NULL means platform-independent (a pack variant); `arch` `any` matches every arch.
CREATE TABLE IF NOT EXISTS release_builds (
  product        TEXT NOT NULL REFERENCES products(slug),
  release_id     TEXT NOT NULL,
  build_id       TEXT NOT NULL,
  platform       TEXT,
  arch           TEXT NOT NULL DEFAULT 'any',
  format         TEXT,
  build_number   TEXT,
  variant_json   TEXT,
  requires_json  TEXT,
  min_os         TEXT,
  created_at     INTEGER NOT NULL,
  modified_at    INTEGER NOT NULL,
  PRIMARY KEY (product, release_id, build_id),
  FOREIGN KEY (product, release_id) REFERENCES release_metadata(product, release_id)
);

-- "Which releases have a build for this platform and arch" is P2-05's per-platform resolution.
CREATE INDEX IF NOT EXISTS idx_release_builds_target
  ON release_builds(product, platform, arch);

-- The operator-owned channel policy, per deliverable. It replaces `release_channels.policy_json`,
-- which nothing ever read and every sync rewrote to NULL; `release_channels` stays as the
-- derived "what GitHub says" view.
--
--   pointer_release_id  NULL = follow the newest eligible release. Promote sets it and makes that
--                       release a member of the channel; the FK only binds when it is set.
--   pinned              1 freezes the channel at the pointer (so a pin needs a pointer).
--   includes_json       manifest-declared channels this one includes (["stable"] for beta).
--   min_supported       the DEVICE floor the signed feed carries (a version in the deliverable's
--                       scheme). Not P0-02's release_channel_floors, which is the sync's
--                       anti-rollback high-water mark and stays a separate table: folding the
--                       high-water mark in here would raise every channel's device floor to its
--                       newest version and, once P3 enforces floors, block every older install.
--   critical            flags the current pointer release.
--   source              'manifest' or 'admin', the services_source (0020) precedent: any
--                       operator or CI change sets 'admin', after which a resync leaves the row
--                       alone; "revert to manifest" hands it back.
CREATE TABLE IF NOT EXISTS release_channel_policy (
  product             TEXT NOT NULL REFERENCES products(slug),
  deliverable_id      TEXT NOT NULL,
  channel             TEXT NOT NULL,
  pointer_release_id  TEXT,
  pinned              INTEGER NOT NULL DEFAULT 0,
  includes_json       TEXT,
  min_supported       TEXT,
  critical            INTEGER NOT NULL DEFAULT 0,
  source              TEXT NOT NULL DEFAULT 'manifest',
  created_at          INTEGER NOT NULL,
  modified_at         INTEGER NOT NULL,
  modified_by         TEXT,
  PRIMARY KEY (product, deliverable_id, channel),
  FOREIGN KEY (product, deliverable_id) REFERENCES release_deliverables(product, deliverable_id),
  FOREIGN KEY (product, pointer_release_id) REFERENCES release_metadata(product, release_id),
  CHECK (pinned IN (0, 1)),
  CHECK (critical IN (0, 1)),
  CHECK (source IN ('manifest', 'admin')),
  CHECK (pinned = 0 OR pointer_release_id IS NOT NULL)
);

-- A yanked release resolves only through an explicit pin (README §3.4). Yanks never delete:
-- release_download_tokens holds foreign keys into release_metadata. Unyank deletes THIS row.
-- A release deleted on GitHub is not a yank; it simply stops being listed.
CREATE TABLE IF NOT EXISTS release_yanks (
  product     TEXT NOT NULL REFERENCES products(slug),
  release_id  TEXT NOT NULL,
  reason      TEXT NOT NULL,
  at          INTEGER NOT NULL,
  by          TEXT NOT NULL,
  PRIMARY KEY (product, release_id),
  FOREIGN KEY (product, release_id) REFERENCES release_metadata(product, release_id)
);

-- Backfill: one `app` deliverable for every product that has a release configuration or already
-- has releases in the store. Timestamps are the migration's own clock; `def_json` stays NULL
-- until a manifest declares `deliverables.app` (P2-04). A replay is a no-op.
INSERT INTO release_deliverables
  (product, deliverable_id, kind, pack_type, def_json, def_source, created_at, modified_at)
SELECT product, 'app', 'app', NULL, NULL, 'manifest',
       CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)
  FROM (SELECT product FROM release_config
        UNION
        SELECT DISTINCT product FROM release_metadata)
 WHERE true
ON CONFLICT(product, deliverable_id) DO NOTHING;
