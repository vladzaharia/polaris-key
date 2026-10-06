-- F-31 (plans/F-01.md §6.6 step 1, tier 3): the Go module proxy's row in the platform's
-- per-ecosystem kill switch, `dist_registry_policy` (0058), with the same 50 MiB ceiling as the
-- other source-package feeds (Go's own module zip limit is 500 MiB; an operator may raise it). A
-- feed without a policy row answers the not-found, so the Go feed needs this row to answer at all.
-- Idempotent: a replay is a no-op, and an operator's later change is never overwritten.
INSERT INTO dist_registry_policy (ecosystem, enabled, max_package_bytes_ceiling, updated_at)
VALUES ('go', 1, 52428800, CAST(strftime('%s', 'now') AS INTEGER))
ON CONFLICT(ecosystem) DO NOTHING;
