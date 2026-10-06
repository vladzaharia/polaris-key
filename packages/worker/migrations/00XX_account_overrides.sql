-- U-03 (notes/S-17 §5.12, plans/U-01.md §6.2–6.3): the account override layer, and the one
-- platform-wide migration that moves licence config and secret overrides onto it.
--
-- The licence-level config override layer is removed on every product (owner decisions 3 and 4,
-- 2026-10-04). Operators write managed config for ONE account on ONE product instead; Core merges
-- it where the licence overrides sat (`core/payload.ts`), for the account signed in on the device
-- or, failing that, the owner of the device's licence (`overrideSubject`, Config's alone). A
-- floating licence has no such layer. Entitlement overrides stay on the licence (decision 20).
--
-- Owner (TABLE_OWNERS in packages/docs/scripts/gen-reference.mjs): Config, all three. Expand-only;
-- every statement is `IF NOT EXISTS`, so a replay converges (R11-04).

-- One row per (product, pairwise subject): the account's managed-config layer for that product.
--
--   product, subject  the product and its pairwise subject (`ps_…`). Never the account id
--                     (S-16 §5.1): the row moves with the subject, and a merge re-keys it through
--                     Core's subject-store registry (`services/config/accountOverrideStore.ts`)
--   payload_json      a managed payload with `config` and `secrets` only (no `entitlements`:
--                     those stay on the licence). Catalog-declared secrets are sealed under
--                     PLATFORM_KEK exactly as in `profiles.payload_json` (R12-02, AAD
--                     `…:product-secret:managed:<key>`), so the KEK sweep re-seals them too
--   updated_at        epoch seconds of the last write
--   updated_by        the operator's subject, or `migration`, `merge` or `signin` (the OIDC
--                     provisioning writer, LX-02)
CREATE TABLE IF NOT EXISTS account_overrides (
  product      TEXT NOT NULL,
  subject      TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at   INTEGER NOT NULL,
  updated_by   TEXT NOT NULL,
  PRIMARY KEY (product, subject)
);

-- The migration report (S-17 §5.12 steps 2 and 3): one row per licence the run touched, kept 90
-- days so an operator can re-apply values by hand. Secret values are never written here: secrets
-- (and config keys the catalog flags `secret`, and any sealed value) are listed by name only.
--
--   product, run_id, license_id  the licence and the run (`override_migration.run_id`)
--   outcome      moved (every value reached the owner's row), collapsed (the owner holds several
--                licences of the product and at least one of this licence's values lost), or
--                dropped (no owner: the values are gone)
--   subject      the owner's pairwise subject for moved and collapsed rows; NULL for dropped
--   buyer_email  the licence's own email, if any (never the account's)
--   keys_json    {"config":[…],"secrets":[…]}: the key names the licence carried
--   values_json  {"config":{key:value}} for non-secret config values, and for a collapse
--                {"collapsed":[{bucket,key,keptFrom,kept?,lost?}]} (values only when non-secret)
--   created_at, expires_at  epoch seconds; expires_at = created_at + 90 days (the nightly sweep
--                deletes past it)
CREATE TABLE IF NOT EXISTS override_migration_report (
  product     TEXT NOT NULL,
  run_id      TEXT NOT NULL,
  license_id  TEXT NOT NULL,
  outcome     TEXT NOT NULL CHECK (outcome IN ('moved', 'collapsed', 'dropped')),
  subject     TEXT,
  buyer_email TEXT,
  keys_json   TEXT NOT NULL,
  values_json TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  PRIMARY KEY (product, run_id, license_id)
);
CREATE INDEX IF NOT EXISTS idx_override_migration_report_expires
  ON override_migration_report(expires_at);
-- A merge re-keys a subject's rows and a deletion removes them.
CREATE INDEX IF NOT EXISTS idx_override_migration_report_subject
  ON override_migration_report(product, subject);

-- The migration's one state row (platform-level by design: the run is one platform-wide run).
--
--   login_card_live_at, library_live_at  when an operator flagged I-07 (the login card) and I-11
--                (the portal Library with Activate License) live in production. The notice cannot
--                start before both are set (decision 21), so customers can act on it
--   notice_started_at, run_not_before    the notice, and the earliest run (notice + 30 days)
--   run_id, run_started_at, run_completed_at  the run. From run_started_at, PUT
--                /licenses/<id>/overrides refuses config and secrets (step 4); from
--                run_completed_at, payload.ts stops reading them from the licence (step 5)
--   products_done_json  the products the run has finished (a JSON array), so a run that stopped
--                part-way resumes where it left off
--   run_lease_until     a short lease so two run requests never process one product twice
--   inventory_json, inventory_computed_at  the daily per-product inventory (counts only)
--   columns_emptied_at  when the licences' config and secrets columns were emptied, after the
--                report window (step 5)
CREATE TABLE IF NOT EXISTS override_migration (
  id                    TEXT PRIMARY KEY CHECK (id = 'platform'),
  login_card_live_at    INTEGER,
  login_card_live_by    TEXT,
  library_live_at       INTEGER,
  library_live_by       TEXT,
  notice_started_at     INTEGER,
  notice_started_by     TEXT,
  run_not_before        INTEGER,
  run_id                TEXT,
  run_started_at        INTEGER,
  run_started_by        TEXT,
  run_completed_at      INTEGER,
  products_done_json    TEXT,
  run_lease_until       INTEGER,
  inventory_json        TEXT,
  inventory_computed_at INTEGER,
  columns_emptied_at    INTEGER,
  updated_at            INTEGER NOT NULL
);
