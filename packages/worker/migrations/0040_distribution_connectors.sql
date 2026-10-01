-- P5-02 — store-connector state: the objects a connector tracks and the webhook events it has
-- received (README §3.8 "Connectors and credential custody").
--
-- Both tables are Distribution's (`TABLE_OWNERS.distribution` in the docs generator), written only
-- by `services/distribution/connectors/**` (the App Store Connect connector first; P5-03 and P5-04
-- add `play` and `ms-store`). No ingest writes either, and nothing a manifest says reaches them.
--
-- `dist_connector_objects` — one row per store object a connector has seen: an App Store version,
-- a build, a build upload, a Background Asset version or one of its releases, a webhook it
-- registered. It is what the poller reconciles (webhooks are hints; the API GET is truth) and
-- where an object no release claims yet waits.
--
--   - `object_type` / `object_id` are the store's own resource type and id (`appStoreVersions`,
--     `builds`, `backgroundAssetVersions`, …). They are store-assigned after signing, so they live
--     here and in `dist_availability.platform_ref_json`, never in a release record (README §3.3).
--   - `release_id` is NULL while no release claims the object — a Background Asset version before
--     P5-08 maps asset packs to pack releases, or an App Store version whose version string no
--     release carries. Such a row is shown as UNRESOLVED and writes no availability.
--   - `store_state` is the store's state verbatim; `state` is the availability state it maps to
--     (P2b-03's vocabulary, `services/distribution/availability.ts`), NULL when it maps to none.
--   - `ref_json` holds the store ids that connect this object to others (app, build, version,
--     asset pack, phased release); `detail_json` the rest of what the last GET said.
--   - `terminal = 1` stops the poller re-reading an object whose state can no longer change.
--
-- `dist_connector_events` — every webhook delivery that passed its signature check, stored raw
-- (at most 16 KiB of it) with what was done with it: `applied`, `stored` (an event with no state
-- effect: beta feedback, alternative distribution, a ping), `ignored` (an event type this build
-- does not know), `unresolved` or `failed`. Redelivery is deduplicated in KV first (7 days, like
-- the GitHub webhook); the primary key is the second line. The poll tick prunes rows older than
-- `CONNECTOR_EVENT_RETENTION_SECONDS`.
CREATE TABLE IF NOT EXISTS dist_connector_objects (
  product       TEXT NOT NULL REFERENCES products(slug),
  connector     TEXT NOT NULL,
  object_type   TEXT NOT NULL,
  object_id     TEXT NOT NULL,
  outlet_id     TEXT,
  release_id    TEXT,
  build_id      TEXT NOT NULL DEFAULT '',
  store_state   TEXT,
  state         TEXT,
  ref_json      TEXT,
  detail_json   TEXT,
  terminal      INTEGER NOT NULL DEFAULT 0 CHECK (terminal IN (0, 1)),
  first_seen_at INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  polled_at     INTEGER,
  PRIMARY KEY (product, connector, object_type, object_id)
);

CREATE TABLE IF NOT EXISTS dist_connector_events (
  product       TEXT NOT NULL REFERENCES products(slug),
  connector     TEXT NOT NULL,
  event_id      TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  instance_type TEXT,
  instance_id   TEXT,
  outcome       TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  received_at   INTEGER NOT NULL,
  PRIMARY KEY (product, connector, event_id)
);

CREATE INDEX IF NOT EXISTS idx_dist_connector_events_received
  ON dist_connector_events (product, received_at);
