-- ST-40 (OB-04): SDK sightings, the read side of the console's Integration page.
--
-- One row per (product, sdk, platform, arch): the first and last time an SDK of that kind made a
-- 2xx request to the product, the last SDK version it sent, and `services_ok`, a bitmask with one
-- bit per route namespace that has answered it (`core/integration/sightings.ts` owns the bits).
-- The values are the X-PKey-SDK / -Platform / -Arch / -SDK-Version headers every SDK already
-- sends. No IP, device id, licence or user data is stored. Rows past 90 days are pruned on the
-- existing cron. `platform` and `arch` are '' when the SDK sent none.
--
-- Additive: a Worker still serving during the deploy never reads or writes the table, so the
-- migration may run before the code that uses it. Replay-safe: IF NOT EXISTS, INSERT OR IGNORE.
-- Down: scripts/rollback/0121_sdk_sightings.down.sql.
CREATE TABLE IF NOT EXISTS sdk_sightings (
  product      TEXT NOT NULL REFERENCES products(slug),
  sdk          TEXT NOT NULL,
  platform     TEXT NOT NULL DEFAULT '',
  arch         TEXT NOT NULL DEFAULT '',
  first_seen   INTEGER NOT NULL,
  last_seen    INTEGER NOT NULL,
  sdk_version  TEXT,
  services_ok  INTEGER NOT NULL DEFAULT 0,
  last_ok_at   INTEGER,
  PRIMARY KEY (product, sdk, platform, arch)
);
CREATE INDEX IF NOT EXISTS idx_sdk_sightings_seen ON sdk_sightings(last_seen);

-- One-time backfill from the devices a product already holds, so a mature product is Verified for
-- Licensing at once. Only devices seen in the last 90 days (the prune horizon), only the SDK ids
-- the wire registry lists. A device exists only after an authorised licence request, so the
-- Licensing bit (1) is the one fact it proves. This writes no setup choice: hiding the
-- Integration page stays the operator's act.
INSERT OR IGNORE INTO sdk_sightings
  (product, sdk, platform, arch, first_seen, last_seen, sdk_version, services_ok, last_ok_at)
SELECT d.product,
       d.sdk_name,
       COALESCE(d.platform, ''),
       COALESCE(d.arch, ''),
       MIN(d.first_seen),
       MAX(d.last_seen),
       (SELECT d2.sdk_version FROM devices d2
         WHERE d2.product = d.product AND d2.sdk_name = d.sdk_name
           AND COALESCE(d2.platform, '') = COALESCE(d.platform, '')
           AND COALESCE(d2.arch, '') = COALESCE(d.arch, '')
         ORDER BY d2.last_seen DESC LIMIT 1),
       1,
       MAX(d.last_seen)
  FROM devices d
 WHERE d.sdk_name IN ('node', 'react', 'python', 'swift', 'godot', 'kotlin',
                      'node-server', 'python-server', 'swift-server', 'kotlin-server')
   AND d.last_seen >= CAST(strftime('%s', 'now') AS INTEGER) - 7776000
   AND d.product IN (SELECT slug FROM products)
 GROUP BY d.product, d.sdk_name, COALESCE(d.platform, ''), COALESCE(d.arch, '');
