-- CC-06.1 (plans/CC-01-cloud-connect.md §2.3, §2.4): one row per (product, pairwise subject) that has
-- fetched its Cloud Connect identity. It holds the roster's epoch and the discovery key.
--
--   epoch         the roster epoch (>= 1). It rises by one each time the set of devices or their keys
--                 changes; the Worker notices on the next read (`services/connect/ring.ts`).
--   members_hash  SHA-256 over the sorted `deviceId.signKey.agreeKey` lines of the epoch's members:
--                 what "the same roster" means. No device list is stored.
--   disc_key      32 random bytes, base64url: the current discovery key (K_disc), new each epoch.
--   prev_disc_key the key before the last bump, delivered for 24 h after `bumped_at`; NULL before
--                 the first bump. prev_epoch is the epoch it belonged to.
--   bumped_at     when `epoch` last changed (epoch seconds).
--
-- A subject store (`connect.rings`): merged and deleted with the account's data. Owned by connect
-- (TABLE_OWNERS), written only from services/connect. No foreign keys, no cascades (R11-01).
-- Expand-only: a Worker built before this migration never names the table. Rollback:
-- scripts/rollback/0145_connect_rings.down.sql.
CREATE TABLE IF NOT EXISTS connect_rings (
  product       TEXT NOT NULL,
  subject       TEXT NOT NULL,
  epoch         INTEGER NOT NULL,
  members_hash  TEXT NOT NULL,
  disc_key      TEXT NOT NULL,
  prev_disc_key TEXT,
  prev_epoch    INTEGER,
  bumped_at     INTEGER NOT NULL,
  PRIMARY KEY (product, subject)
);
