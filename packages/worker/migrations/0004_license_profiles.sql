-- Polaris Key v1: ordered reusable profile stack per license.
-- The legacy licenses.profile_id column is intentionally left in place as a compatibility
-- bridge for local/dev databases, but runtime reads the normalized stack below.

CREATE TABLE IF NOT EXISTS license_profiles (
  product    TEXT NOT NULL REFERENCES products(slug),
  license_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  PRIMARY KEY (product, license_id, profile_id)
);

CREATE INDEX IF NOT EXISTS idx_license_profiles_license
  ON license_profiles(product, license_id, sort_order);

INSERT OR IGNORE INTO license_profiles (product, license_id, profile_id, sort_order)
SELECT product, id, profile_id, 0
FROM licenses
WHERE profile_id IS NOT NULL;

