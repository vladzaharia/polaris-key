-- LX-08 (plans/LX-01.md §6.1, notes/S-19 §7.2 and §7.14 step 1): the licensing model's Core tables.
--
-- Model OC (S-19 decision 1): a licence is an access contract; a GRANT is one reason someone holds
-- entitlements. A grant has exactly one holder: an account, a licence or a store identity. This
-- migration only EXPANDS: every statement is `IF NOT EXISTS`, nothing existing is renamed, dropped
-- or rebuilt, and a Worker deployed before it never names these tables, so the window between
-- `wrangler d1 migrations apply` and the deploy is safe (old Worker safe: yes, additive).
--
-- Owner (TABLE_OWNERS in packages/docs/scripts/gen-reference.mjs): Core, all five. Writers:
-- `grants` and `grant_entitlements` only through `src/core/grants.ts` (Commerce's store grants
-- through License's `applyStoreGrant`, Identity's sign-in writer for `oidc` grants);
-- `device_store_identities` only through Core (I-14 and LX-11, nothing writes it yet);
-- `holder_versions` and `entitlement_events` are created empty (LX-09 and LX-13 write them).
--
-- Reads stay on the old objects until LX-09 (§7.14 step 5), with one exception: the `oidc` grant
-- is rendered by `core/payload.ts` where the provisioned licence overrides used to sit, because
-- step 4 moves those keys out of `licenses.overrides_json`.

-- One grant: a reason a holder has entitlements.
--
--   id                   `grt_<…>`. Deterministic for migrated and dual-written rows, so a replay
--                        converges: `grt_s_<store>_<purchase_key_hash>` for a store purchase,
--                        `grt_oidc_<license_id>` for the OIDC-provisioned keys of one licence
--   account_id, license_id, store_identity_hash
--                        the holder, exactly one of the three (CHECK below). `account_id` is the
--                        global account id and never leaves the Worker (S-16 §5.1)
--   source               vocabulary by trigger (below), so a later source needs no rebuild
--   external_ref_hash    the store purchase key hash, a provider's payment or subscription id,
--                        hashed; unique per (product, source)
--   sku, order_ref       the store product id or catalog SKU; the order or bundle a refund groups
--   state                vocabulary by trigger (below)
--   granted_at, expires_at, grace_until   epoch seconds; expires_at NULL is perpetual
--   shared, trial        family-shared or borrowed; a trial grant
--   created_by, modified_at, modified_by  `migration`, `commerce`, `oidc`, an admin subject
CREATE TABLE IF NOT EXISTS grants (
  product             TEXT NOT NULL REFERENCES products(slug),
  id                  TEXT NOT NULL,
  account_id          TEXT NULL,
  license_id          TEXT NULL,
  store_identity_hash TEXT NULL,
  source              TEXT NOT NULL,
  external_ref_hash   TEXT NULL,
  sku                 TEXT NULL,
  order_ref           TEXT NULL,
  state               TEXT NOT NULL DEFAULT 'active',
  granted_at          INTEGER NOT NULL,
  expires_at          INTEGER NULL,
  grace_until         INTEGER NULL,
  shared              INTEGER NOT NULL DEFAULT 0 CHECK (shared IN (0, 1)),
  trial               INTEGER NOT NULL DEFAULT 0 CHECK (trial IN (0, 1)),
  created_by          TEXT NOT NULL,
  modified_at         INTEGER NOT NULL,
  modified_by         TEXT NOT NULL,
  PRIMARY KEY (product, id),
  CHECK ((account_id IS NOT NULL) + (license_id IS NOT NULL) + (store_identity_hash IS NOT NULL) = 1)
);

CREATE INDEX IF NOT EXISTS idx_grants_account
  ON grants(product, account_id) WHERE account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_grants_license
  ON grants(product, license_id) WHERE license_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_grants_store
  ON grants(product, store_identity_hash) WHERE store_identity_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_grants_ref
  ON grants(product, source, external_ref_hash) WHERE external_ref_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_grants_order
  ON grants(product, order_ref) WHERE order_ref IS NOT NULL;

-- The vocabularies as replaceable triggers (0015's R11-07 precedent), so LX-23's sources need no
-- table rebuild. `polaris-key` is a sale made through Polaris Key itself (S-21 D9, S-22 D9; the
-- plan's `direct`); nothing writes it before CM-05.
CREATE TRIGGER IF NOT EXISTS trg_grants_source_ins
BEFORE INSERT ON grants
WHEN NEW.source NOT IN ('app-store', 'play', 'steam', 'polaris-key', 'comp', 'trial', 'bundle', 'redeem', 'oidc')
BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: grants.source'); END;

CREATE TRIGGER IF NOT EXISTS trg_grants_source_upd
BEFORE UPDATE OF source ON grants
WHEN NEW.source NOT IN ('app-store', 'play', 'steam', 'polaris-key', 'comp', 'trial', 'bundle', 'redeem', 'oidc')
BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: grants.source'); END;

CREATE TRIGGER IF NOT EXISTS trg_grants_state_ins
BEFORE INSERT ON grants
WHEN NEW.state NOT IN ('active', 'past_due', 'revoked', 'refunded', 'suppressed')
BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: grants.state'); END;

CREATE TRIGGER IF NOT EXISTS trg_grants_state_upd
BEFORE UPDATE OF state ON grants
WHEN NEW.state NOT IN ('active', 'past_due', 'revoked', 'refunded', 'suppressed')
BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: grants.state'); END;

-- One key a grant carries (a bundle or Deluxe SKU carries several).
--
--   value_json   the entry's value as JSON: `true` for a store flag, an integer for a seat pack
--                or quota, the provisioned value for an `oidc` grant
--   state        the ManagedEntry state; only `oidc` grants copy a non-default one
--   updated_at   the legacy entry's `updatedAt`, copied exactly, so a `legacy` document renders
--                byte for byte as before
CREATE TABLE IF NOT EXISTS grant_entitlements (
  product    TEXT NOT NULL,
  grant_id   TEXT NOT NULL,
  key        TEXT NOT NULL,
  value_json TEXT NOT NULL DEFAULT 'true',
  state      TEXT NOT NULL DEFAULT 'default' CHECK (state IN ('default', 'enforced', 'hidden')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (product, grant_id, key)
);

-- A Steam identity verified on a device (the store holder of S-19 §7.3.1). Written by I-14 and
-- LX-11 through Core; empty until then.
CREATE TABLE IF NOT EXISTS device_store_identities (
  product             TEXT NOT NULL,
  device_id           TEXT NOT NULL,
  store               TEXT NOT NULL CHECK (store = 'steam'),
  store_identity_hash TEXT NOT NULL,
  verified_at         INTEGER NOT NULL,
  PRIMARY KEY (product, device_id, store)
);

-- The effective set's cache key per holder (S-19 §7.3.5). LX-09 bumps and reads it.
CREATE TABLE IF NOT EXISTS holder_versions (
  product     TEXT NOT NULL,
  holder_kind TEXT NOT NULL CHECK (holder_kind IN ('account', 'license', 'store')),
  holder_id   TEXT NOT NULL,
  version     INTEGER NOT NULL,
  PRIMARY KEY (product, holder_kind, holder_id)
);

-- The `entitlements.changed` feed with a pull cursor (plans/LX-01.md §8 Q4; webhooks later).
-- `subject` is the product's pairwise subject, never the account id; a merge re-keys it and a
-- deletion removes it through Core's subject-store registry (`core/entitlementEvents.ts`). LX-13
-- writes it.
CREATE TABLE IF NOT EXISTS entitlement_events (
  product    TEXT NOT NULL,
  id         TEXT NOT NULL,
  subject    TEXT NULL,
  license_id TEXT NULL,
  keys_json  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (product, id)
);

CREATE INDEX IF NOT EXISTS idx_entitlement_events_time
  ON entitlement_events(product, created_at, id);
CREATE INDEX IF NOT EXISTS idx_entitlement_events_subject
  ON entitlement_events(product, subject) WHERE subject IS NOT NULL;
