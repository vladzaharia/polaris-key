-- P5-03 — operator-owned store-connector settings (README §3.8 "Connectors and credential
-- custody", §3.9 "Rollouts, halts and telemetry").
--
-- One row per (product, connector): the settings an OPERATOR chose for that connector, as one
-- JSON object the connector validates on read and on write. The Google Play connector is the
-- first user: its in-app update priority policy (the default `inAppUpdatePriority` a release gets
-- when its rollout starts) and its opt-in vitals auto-halt (crash and ANR rate thresholds, the
-- window and the minimum sample) — off by default, so an absent row means "nothing automatic".
--
-- Distribution's (`TABLE_OWNERS.distribution` in the docs generator), written only by
-- `services/distribution/connectors/settings.ts`, which only a connector's console control
-- reaches (platform-admin session, CSRF, rate limit; every write audited with the session's
-- subject). No ingest writes it and nothing a manifest says reaches it: a repo push must never
-- turn on an automatic halt or change what priority players' devices see.
--
--   - `settings_json` is the whole normalised object; a reader that cannot parse it, or finds a
--     field out of range, falls back to that field's default (the defaults are the safe ones:
--     auto-halt off, priority 0).
--   - `updated_by` is the session subject of the last write.
CREATE TABLE IF NOT EXISTS dist_connector_settings (
  product       TEXT NOT NULL REFERENCES products(slug),
  connector     TEXT NOT NULL,
  settings_json TEXT NOT NULL,
  updated_at    INTEGER NOT NULL,
  updated_by    TEXT NOT NULL,
  PRIMARY KEY (product, connector)
);
