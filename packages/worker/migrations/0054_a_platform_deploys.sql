-- A-11 (notes/S-13 §4, §6.1): the deploy history. One row per production deploy, written ONLY by
-- the final step of `.github/workflows/deploy.yml` (`scripts/record-deploy.mjs`, through
-- `wrangler d1 execute` with the deploy token that already applies these migrations). The Worker
-- only reads it (`GET /manage/api/platform/deployment`); no request path writes it. Core-owned
-- (`TABLE_OWNERS.core` in the docs generator). Product-less by construction.
--
-- `id` is `<run id>-<run attempt>`, so a re-run of the same workflow run records a second row
-- rather than overwriting the first. `at` is epoch seconds at insert time. `scripts` is a JSON
-- array of the Worker scripts the run deployed. `cf_version_id` / `deltas_version_id` are the
-- Cloudflare version ids `wrangler deploy` reported for the request Worker and the lazy-delta
-- consumer (NULL when wrangler did not report one). `smoke` is the smoke check's outcome as the
-- workflow saw it (`success`, `failure`, `skipped`, ...): a row is written once the request
-- Worker is live, even if the smoke check then fails, because the row records what is deployed.
--
-- Nothing in it is secret: tag, commit, run URL and version ids are visible to anyone who can see
-- the repository's Actions tab or the Cloudflare dashboard (THREAT-MODEL "Platform settings and
-- operations").
CREATE TABLE IF NOT EXISTS platform_deploys (
  id                TEXT PRIMARY KEY,
  at                INTEGER NOT NULL,
  environment       TEXT NOT NULL,
  tag               TEXT NOT NULL,
  git_sha           TEXT NOT NULL,
  run_url           TEXT,
  scripts           TEXT NOT NULL,
  latest_migration  TEXT,
  cf_version_id     TEXT,
  deltas_version_id TEXT,
  smoke             TEXT
);
CREATE INDEX IF NOT EXISTS idx_platform_deploys_at ON platform_deploys(at DESC, id DESC);
