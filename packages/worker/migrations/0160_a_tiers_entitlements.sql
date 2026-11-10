-- LX-34.2: a tier's entitlements bucket.
--
-- `tiers.entitlements_json` holds the entitlements a tier grants, as a managed-payload
-- `entitlements` map (key -> { state, value, updatedAt }), the shape the tier profile's bucket has
-- today. NULL = none. Nothing reads or writes it yet: the manifest ingest (LX-34.5) and the
-- `license.entitlement-buckets` job (LX-34.8) fill it, and the read switch (LX-34.10, release N+1)
-- makes it the tier layer. No upsert may reset it: a console or manifest upsert names its columns.
-- Provisional number; the lead numbers it at merge.
-- Rollback: scripts/rollback/0160_entitlement_buckets.down.sql.
ALTER TABLE tiers ADD COLUMN entitlements_json TEXT;
