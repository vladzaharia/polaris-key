-- I-49.4 (plans/I-49-slices.md D-1..D-3, D-9): the silent-restore keys. A restore key lets one
-- app on one new device sign in again without asking, from a secret the person's own platform
-- backup (iCloud Keychain, Block Store) carries. One row per (product, device).
--
--   id           `rk_` + 22 base64url characters: the public half, safe to log.
--   secret_hash  HMAC(KEY_HASH_PEPPER, "restore:" + secret), hex. The secret is shown once, to the device
--                that enrols, and never stored: a database leak confirms no guess.
--   subject      the pairwise subject the device was signed in as when it enrolled (never an account id).
--   created_at   when the secret was minted; "current" on a check needs it under 90 days old.
--   checked_at   when the device last confirmed the row; a row not checked in 180 days is swept.
--
-- identity_restore_origins records which devices signed in BY restore, so that removing one of them
-- also drops every restore row of its subject (a stolen backup is then cut off at the root).
-- A row is written when a restore redeems and goes with the device's sign-out or removal.
--
-- Both tables are subject stores (`identity.restore`): merged, exported (dates only, never a
-- hash) and deleted with the account's data and with the product. Owned by identity
-- (TABLE_OWNERS). No foreign keys, no cascades (R11-01). Expand-only: a Worker built before this
-- migration never names them. Rollback: scripts/rollback/0152_identity_restore_keys.down.sql.
CREATE TABLE IF NOT EXISTS identity_restore_keys (
  id          TEXT PRIMARY KEY,
  product     TEXT NOT NULL,
  device_id   TEXT NOT NULL,
  subject     TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  checked_at  INTEGER NOT NULL,
  UNIQUE (product, device_id)
);
CREATE INDEX IF NOT EXISTS identity_restore_keys_subject
  ON identity_restore_keys (product, subject);

CREATE TABLE IF NOT EXISTS identity_restore_origins (
  product    TEXT NOT NULL,
  device_id  TEXT NOT NULL,
  subject    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (product, device_id)
);
CREATE INDEX IF NOT EXISTS identity_restore_origins_subject
  ON identity_restore_origins (product, subject);
