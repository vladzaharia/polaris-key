-- P3-03 — CI-signed release records and the signed channel feed (wire v4, plans/P3-01.md §6).
--
-- `release_config.release_keys_json` — the product's declared release keys (`.pkey/release`
-- `releaseKeys`, `[{kid, publicKey}]`), written by link and resync. NULL = none declared, and
-- then a publish carrying a record is refused (`release_record_rejected`, reason `kid`). The sync
-- never writes a key equal to one of the product's signing keys (`release_key_is_product_key`).
ALTER TABLE release_config ADD COLUMN release_keys_json TEXT;

-- `release_records` — Release's. One row per ingested `pkey-release+jws`, written only by the CI
-- submit (`services/release/records.ts`) after every check of the ingest passed, in the same batch
-- as the descriptor's rows. NEVER rewritten: a record is evidence, and its hash is what a feed
-- pins. `jws` holds the exact compact JWS bytes CI sent (ASCII); `record_sha256` is the lowercase
-- hex SHA-256 of them, the record route's path segment. `seq` is the release's `seq`, so a
-- deliverable has at most one record per seq; `kind` is the record's own (`app` in v4; P4-02
-- adds `pack`). `kid` names the release key that signed it.
CREATE TABLE IF NOT EXISTS release_records (
  product        TEXT NOT NULL REFERENCES products(slug),
  deliverable_id TEXT NOT NULL,
  release_id     TEXT NOT NULL,
  seq            INTEGER NOT NULL,
  kind           TEXT NOT NULL,
  record_sha256  TEXT NOT NULL,
  kid            TEXT NOT NULL,
  jws            TEXT NOT NULL,
  ingested_at    INTEGER NOT NULL,
  PRIMARY KEY (product, record_sha256),
  UNIQUE (product, deliverable_id, seq)
);
CREATE INDEX IF NOT EXISTS release_records_by_release
  ON release_records (product, release_id);

-- The three tables below are Update's (`TABLE_OWNERS.update`), written only by
-- `services/update/feedDoc.ts` and the operator's `feed:seq-ceiling` script. `channel` is always
-- the CANONICAL channel (`classifyChannel`: `latest` is stored as `stable`), never a requested
-- spelling, so one channel has one `seq` and one floor on every device.

-- `update_feed_state` — the feed's `seq` per (product, canonical channel), shared by every
-- selector document of the channel. Bumped only when the composed content's SHA-256 changes, in
-- one conditional `UPDATE … WHERE seq = ?`, to `min(seq + 1, 9007199254740991)`. A new row starts
-- at 1, or at 9007199254740991 when the product has an `update_feed_ceiling` row (one
-- `INSERT … SELECT`, so the flag is read in the same statement).
CREATE TABLE IF NOT EXISTS update_feed_state (
  product        TEXT NOT NULL REFERENCES products(slug),
  channel        TEXT NOT NULL,
  seq            INTEGER NOT NULL,
  content_sha256 TEXT NOT NULL,
  PRIMARY KEY (product, channel)
);

-- `update_feed_ceiling` — the product's `seq` ceiling flag (WIRE-CONTRACT-V4 §4). Written only by
-- `pnpm --filter @polaris-key/worker feed:seq-ceiling --product <slug>` after a suspected
-- product-key or Worker compromise, and never deleted: from then on every channel of the product,
-- including one that has no `update_feed_state` row yet, signs at the ceiling.
CREATE TABLE IF NOT EXISTS update_feed_ceiling (
  product TEXT NOT NULL PRIMARY KEY REFERENCES products(slug),
  set_at  INTEGER NOT NULL
);

-- `update_feed_docs` — the signed feed documents, one per (product, canonical channel, selector
-- key), served byte-for-byte to every data centre. `selector_key` is '' for the channel-wide
-- document and `platform=<p>` for a per-platform one. A request re-signs only when the channel's
-- content hash changed (`content_sha256` differs from `update_feed_state`'s) or the stored copy is
-- 450 s old (`signed_at`). The ceiling script deletes a product's rows.
CREATE TABLE IF NOT EXISTS update_feed_docs (
  product        TEXT NOT NULL REFERENCES products(slug),
  channel        TEXT NOT NULL,
  selector_key   TEXT NOT NULL,
  seq            INTEGER NOT NULL,
  content_sha256 TEXT NOT NULL,
  jws            TEXT NOT NULL,
  signed_at      INTEGER NOT NULL,
  PRIMARY KEY (product, channel, selector_key)
);
