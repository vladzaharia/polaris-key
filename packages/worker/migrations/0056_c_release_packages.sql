-- F-03 (plans/F-01.md §6.3): `release_packages` — Release's. What is package-specific about a
-- package release. The release itself is an ordinary `release_metadata` row of its `kind:
-- package` deliverable, with `release_id` = `<deliverable>@<version>` and no builds; its files
-- are `release_artifacts` rows of role `payload`, held by `blob_refs` as every artifact is (so the
-- blob collector keeps them). This table adds the ecosystem facts the package feeds render from.
--
--   name_norm      the uniqueness key: the PEP 503 name for PyPI, lower case for npm, Swift and
--                  Maven, the name itself for OCI and Godot (`packageNameNorm`).
--   state          live | yanked | deprecated. A yank changes it; nothing deletes a row.
--   state_message  the npm deprecation message or the PEP 592 yank reason.
--   files_json     [{name, type, sha256, size, mediaType?, classifier?, extension?, sha1?,
--                  sha512?, md5?}] — the Worker-computed digests (npm and Maven) included.
--   metadata_json  the validated extractor output (the descriptor's `package.metadata`).
--   source_json    {kind: 'oidc'|'static'|'console', publisher?, runUrl?, tokenId?}.
--
-- UNIQUE FOREVER. The primary key is (product, ecosystem, name_norm, version) and rows are never
-- deleted (tier 1 has no package delete, and Release's admin delete refuses a package release):
-- a yanked or deprecated version can never be published again (`release_exists`, reason
-- `package-version-taken`), which is what makes protocol-fixed byte names (npm tarballs, Swift
-- archives, Maven files) immutable. Idempotent statements only.
CREATE TABLE IF NOT EXISTS release_packages (
  product        TEXT NOT NULL REFERENCES products(slug),
  ecosystem      TEXT NOT NULL,
  name_norm      TEXT NOT NULL,
  version        TEXT NOT NULL,
  deliverable_id TEXT NOT NULL,
  release_id     TEXT NOT NULL,
  name           TEXT NOT NULL,
  state          TEXT NOT NULL DEFAULT 'live' CHECK (state IN ('live', 'yanked', 'deprecated')),
  state_message  TEXT,
  files_json     TEXT NOT NULL,
  metadata_json  TEXT NOT NULL,
  source_json    TEXT NOT NULL,
  published_at   INTEGER NOT NULL,
  PRIMARY KEY (product, ecosystem, name_norm, version),
  FOREIGN KEY (product, release_id) REFERENCES release_metadata(product, release_id)
);

-- `releaseCatalog.packageVersions(deliverableId)` reads a deliverable's versions; a release's row
-- is found by its id on yank, unyank and deprecate.
CREATE INDEX IF NOT EXISTS idx_release_packages_deliverable
  ON release_packages(product, deliverable_id, published_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_release_packages_release
  ON release_packages(product, release_id);
