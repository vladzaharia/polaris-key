-- F-30 (plans/F-01.md §6.4): the Cargo feed's row in the platform's per-ecosystem kill switch.
--
-- `dist_registry_policy` (0058) holds one row per ecosystem, and the registry's access ladder reads
-- a missing row as "off" (fail closed), so a feed of an ecosystem without one never answers. The
-- Cargo feed ships with this build: seed its row with S-12 §8.4's default ceiling (50 MiB per
-- package), switched on, like the six tier-1 rows. An operator can switch it off in the console
-- (Platform → Package feeds) like any other.
--
-- Expand-only and idempotent: one insert into an existing table, a no-op on replay or when an
-- operator has already written the row.
INSERT INTO dist_registry_policy (ecosystem, enabled, max_package_bytes_ceiling, updated_at)
VALUES ('cargo', 1, 52428800, CAST(strftime('%s', 'now') AS INTEGER))
ON CONFLICT(ecosystem) DO NOTHING;
