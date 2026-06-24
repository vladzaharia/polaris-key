-- Admin-assignable upgrade channels + version windows, per license and per tier.
-- These columns hold the admin POLICY; it is injected as ENFORCED entitlements during
-- effective-config resolution (channels / app.minVersion / app.maxVersion) so the existing
-- gate.ts checkBuildGate logic governs them unchanged. channels_json is a JSON string array.

ALTER TABLE licenses ADD COLUMN channels_json TEXT;
ALTER TABLE licenses ADD COLUMN min_version  TEXT;
ALTER TABLE licenses ADD COLUMN max_version  TEXT;
ALTER TABLE tiers    ADD COLUMN channels_json TEXT;
ALTER TABLE tiers    ADD COLUMN min_version  TEXT;
ALTER TABLE tiers    ADD COLUMN max_version  TEXT;
