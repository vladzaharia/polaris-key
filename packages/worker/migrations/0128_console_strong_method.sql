-- ST-30 slice 2b (ST-28 plan §2.4-§2.5): the strong-method rule and the computed root rule.
--
-- `account_links.strong_at` — when this sign-in method became eligible to open the console (SM-3),
-- or NULL. An email code, and any method added in the portal, stays NULL (SM-4). Existing rows
-- are NULL on purpose: nothing is strong until a console sign-in through the console IdP marks it
-- (SM-3(c)), which today's operators do at their next sign-in.
--
-- `account_links.asserted_at` — when the IdP last asserted this link's groups, written in the same
-- UPDATE as `groups_json` and never otherwise (the root rule's 8 h freshness reads it, not
-- `last_used_at`). NULL means no fresh assertion: root and rules deny until the next IdP sign-in.
--
-- `account_links.member_id` — the console member id (`mbr_…`) of the account, written at each console
-- sign-in, so an audit filter on a member id is one indexed read instead of a scan. Advisory: the
-- reader recomputes the id from the account before trusting it.
--
-- Identity owns them (account_links is already in TABLE_OWNERS). Expand-only: a Worker deployed
-- before this migration never names them. Rollback: scripts/rollback/0128_console_strong_method.down.sql.
ALTER TABLE account_links ADD COLUMN strong_at INTEGER;
ALTER TABLE account_links ADD COLUMN asserted_at INTEGER;
ALTER TABLE account_links ADD COLUMN member_id TEXT;
CREATE INDEX IF NOT EXISTS idx_account_links_member ON account_links(member_id) WHERE member_id IS NOT NULL;
