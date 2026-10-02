-- P2b-05 — storefront feeds (README §3.8 "Storefront feeds").
--
-- `release_builds.metadata_json` (Release's table): the descriptor's optional `builds[].metadata`
-- (`@polaris-key/manifest` `validateReleaseDescriptor`), what `pkey release publish` read out of
-- an IPA (bundle identifier, versions, minimum OS, entitlements and privacy strings) or an APK
-- (package name, version code and name, minimum SDK, ABIs, signer fingerprint). Written by the
-- descriptor ingest alone, read through the `releaseCatalog` hook by Distribution's feed
-- renderers. The Worker validates the shape; it never unzips an archive. NULL on every build
-- before P2b-05 and on every build whose descriptor carried none.
ALTER TABLE release_builds ADD COLUMN metadata_json TEXT;

-- `dist_feed_files` (Distribution's, `TABLE_OWNERS.distribution`): the static files CI generated
-- and signed for a feed Polaris Key relays without holding its key — today one F-Droid repository
-- per channel (`entry.jar`, `entry.json`, `index-v2.json`, `diff/<timestamp>.json`, `icons/…`).
-- CI uploads the bytes through P2-02's upload ticket (`distribution:feeds`) into the
-- content-addressed blob store, then registers the set at `POST /<p>/distribution/feeds/fdroid/
-- <channel>`, which REPLACES the (product, feed, channel) set in one batch: a client never sees a
-- new `entry.jar` beside an old `index-v2.json`.
--
--   - `path` is relative to the repository root, checked by `isSafeAssetPath` on write and read.
--   - `sha256` names the object (`blobs/sha256/<sha256>`); the product holds a `feed` ref to it.
--   - `content_type` is the type the relay serves, chosen by the Worker from the extension,
--     never by CI.
CREATE TABLE IF NOT EXISTS dist_feed_files (
  product      TEXT NOT NULL REFERENCES products(slug),
  feed         TEXT NOT NULL,
  channel      TEXT NOT NULL,
  path         TEXT NOT NULL,
  sha256       TEXT NOT NULL,
  size         INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (product, feed, channel, path)
);
