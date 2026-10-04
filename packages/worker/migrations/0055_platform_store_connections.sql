-- A-16 — platform store connections (notes/S-13, owner decision 2026-10-04).
--
-- One TEAM-LEVEL connection per store, held by the platform rather than by a product: the App
-- Store Connect team API key (sees every app of the team), the team's In-App Purchase key (the
-- App Store Server API of every app of the team) and the Apple Team ID. Later the Google Play
-- and Microsoft Store team keys join the same tables. A product's own outlet credential
-- (`outlet_credentials`, P5-01) still wins; the platform credential is the FALLBACK, and only
-- ever for the one app a platform admin assigned to that product (`platform_credential_pins`).
--
-- All three tables are Core's (`TABLE_OWNERS.core`) and `core/platformCredentials.ts` /
-- `core/platformStoreSettings.ts` are their only accessors (`test/outletCredentialReach.test.ts`
-- also guards these names). Rows are written ONLY by a platform admin through
-- `/manage/api/platform/store-connections/…`, never from a manifest, a resync or a service hook.
--
-- `platform_credentials` — the console-managed credential of one slot (`app-store.api-key`,
-- `app-store.in-app-purchase-key`). `enc_value_json` is sealed under PLATFORM_KEK with the AAD
-- `pkey:v2:_platform:platform-credential:<credential_id>` (`_platform` cannot be a product slug,
-- and the kind is its own), so a blob copied into `outlet_credentials` or `product_secrets` does
-- not open there. The KEK re-seal sweep re-seals it. `meta_json` holds non-secret display fields
-- only (key id, issuer id). A Worker secret (`PLATFORM_ASC_API_KEY`,
-- `PLATFORM_APP_STORE_SERVER_KEY`) is the second source, consulted only when no active row exists.
CREATE TABLE IF NOT EXISTS platform_credentials (
  credential_id  TEXT PRIMARY KEY,
  store          TEXT NOT NULL,
  slot           TEXT NOT NULL,
  kind           TEXT NOT NULL,
  enc_value_json TEXT NOT NULL,
  meta_json      TEXT NOT NULL DEFAULT '{}',
  status         TEXT NOT NULL DEFAULT 'active',
  created_at     INTEGER NOT NULL,
  created_by     TEXT NOT NULL,
  rotated_at     INTEGER,
  last_used_at   INTEGER,
  last_ok_at     INTEGER,
  last_error     TEXT
);

-- `platform_credential_pins` — the operator's per-product pin for a platform credential: the one
-- store app (`appleId` for the API key, `bundleId` for the In-App Purchase key) a product's
-- connector may use the TEAM key for. No pin, no use. One app per product per credential, and —
-- a table constraint, so a half-applied migration cannot drop it — one product per app: the
-- platform key can never be aimed at an app another product holds. Deleting a product deletes its
-- pins (`deleteProduct`), which frees the app for another product.
CREATE TABLE IF NOT EXISTS platform_credential_pins (
  credential_id TEXT NOT NULL,
  product       TEXT NOT NULL REFERENCES products(slug),
  pin           TEXT NOT NULL,
  pinned_at     INTEGER NOT NULL,
  pinned_by     TEXT NOT NULL,
  PRIMARY KEY (product, credential_id),
  UNIQUE (credential_id, pin)
);

-- `platform_store_settings` — non-secret, console-editable values of a store connection (today
-- the Apple Team ID, `app-store` / `teamId`). The Worker var `PLATFORM_APPLE_TEAM_ID` is the
-- second source. A product's own explicit value (a trust policy's `appAttest.teamId`) wins.
CREATE TABLE IF NOT EXISTS platform_store_settings (
  store      TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (store, key)
);

-- `platform_audit` — the product-less audit trail every platform-level write and team-wide key
-- open above lands in (`core/platformEvents.ts`). This is A-12's table (notes/S-13 §6.1; A-12 is
-- on the unmerged A-11 branch as `0054_b_platform_audit.sql`), created here with the SAME
-- statement and index so A-16 never loses an event while A-12 is pending: whichever migration
-- applies first creates it, the other is a no-op (`IF NOT EXISTS`). When A-12 merges, its copy is
-- the canonical one and this block can be dropped in the merge. A writer must never put a secret,
-- key material or anything derived from one in any column. Core-owned (`TABLE_OWNERS.core`).
CREATE TABLE IF NOT EXISTS platform_audit (
  id          TEXT PRIMARY KEY,
  at          INTEGER NOT NULL,
  actor_sub   TEXT,
  actor_name  TEXT,
  actor_email TEXT,
  action      TEXT NOT NULL,
  target_kind TEXT,
  target_id   TEXT,
  summary     TEXT,
  before_json TEXT,
  after_json  TEXT
);
CREATE INDEX IF NOT EXISTS idx_platform_audit_at ON platform_audit(at DESC, id DESC);
