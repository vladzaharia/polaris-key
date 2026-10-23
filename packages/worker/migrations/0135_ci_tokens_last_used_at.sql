-- F-33b.2 (D-F5): when the registry host last accepted a CI token, at hourly resolution.
-- NULL until first use. Core owns ci_tokens. Expand-only: a Worker deployed before this migration
-- never names the column. Rollback: scripts/rollback/0135_ci_tokens_last_used_at.down.sql.
ALTER TABLE ci_tokens ADD COLUMN last_used_at INTEGER;
