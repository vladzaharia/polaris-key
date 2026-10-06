-- F-22 (wp/F-22-native-publish.md, S-12 §10 tier 2): native-client upload sessions.
--
-- twine uploads each wheel and the sdist of a version in a request of its own, and Maven and
-- Gradle PUT each file of a version separately (then checksums, then `maven-metadata.xml`). A
-- package version is unique forever and never gains files once published (F-03), so such a
-- version is GATHERED here first, one row per `(product, ecosystem, name_norm, version)`, and
-- published once, as one release, through the same descriptor and ingest as `pkey release
-- publish` (`services/release/packages/native/sessions.ts`). `npm publish` and
-- `swift package-registry publish` send a whole version in one request and never write here.
--
--   session_id     the staging prefix the files sit under (`staging/<product>/<session_id>/`),
--                  written by the Worker only; the bucket's one-day rule clears it
--   principal_id   the publishing token (`rtok:<id>` or `ci:<id>`): a session is that token's
--                  alone, and another token's upload of the version is refused while it is open
--   principal_json the principal as the audit and `release_packages.source_json` record it
--   files_json     the staged files: [{name, type, sha256, size, staging, extension?,
--                  classifier?, md5?, sha1?, sha512?}] (the digests check Maven's sidecars)
--   metadata_json  the ecosystem metadata gathered so far (twine's fields, the POM's packaging)
--   state          open → finalizing → published | failed (a failed version may be uploaded again)
--   touch_seq      bumped when a request of the same token on the feed begins and when a file is
--                  added; a pending settle publishes only while it is unchanged
--
-- Release-owned (TABLE_OWNERS.release). Expand-only: a new table no deployed Worker names.

CREATE TABLE IF NOT EXISTS release_native_uploads (
  product        TEXT NOT NULL REFERENCES products(slug),
  ecosystem      TEXT NOT NULL,
  name_norm      TEXT NOT NULL,
  version        TEXT NOT NULL,
  deliverable_id TEXT NOT NULL,
  name           TEXT NOT NULL,
  session_id     TEXT NOT NULL,
  principal_id   TEXT NOT NULL,
  principal_json TEXT NOT NULL,
  client         TEXT NOT NULL,
  files_json     TEXT NOT NULL DEFAULT '[]',
  metadata_json  TEXT NOT NULL DEFAULT '{}',
  channel        TEXT,
  state          TEXT NOT NULL DEFAULT 'open'
                   CHECK (state IN ('open', 'finalizing', 'published', 'failed')),
  error          TEXT,
  release_id     TEXT,
  touch_seq      INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (product, ecosystem, name_norm, version)
);

CREATE INDEX IF NOT EXISTS idx_release_native_uploads_principal
  ON release_native_uploads(product, ecosystem, principal_id, state);
CREATE INDEX IF NOT EXISTS idx_release_native_uploads_state
  ON release_native_uploads(product, state, updated_at);
