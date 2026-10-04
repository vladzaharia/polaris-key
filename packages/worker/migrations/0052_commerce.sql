-- P6-01 — the commerce bridge: store purchases (App Store, Google Play, Steam) become licence
-- flags, per deliverable (README §3.10, CONTENT §6.7 item 9).
--
-- Three tables are Distribution's (`TABLE_OWNERS.distribution` in the docs generator), written only
-- by `services/distribution/commerce/**`; one is License's (`TABLE_OWNERS.license`), written only
-- by License's `applyStoreGrant` descriptor hook (`services/license/storeGrants.ts`). No manifest
-- ingest writes any of them.
--
-- `dist_store_products` — the operator's map from a store product to the licence flag it grants
-- and the deliverable it unlocks. Set through Distribution's admin API only (`source` is always
-- `admin`): a repo push must never decide what a payment unlocks.
--
-- `dist_purchase_bindings` — one opaque binding UUID per licence, handed to the device before it
-- buys (Apple `appAccountToken`, Play `obfuscatedAccountId`, the Steam web-API ticket identity).
-- It is not the licence id and is not PII. Both keys are table constraints, so a partially
-- applied migration cannot drop the uniqueness the bridge depends on: one binding per licence,
-- and one licence per binding.
--
-- `dist_purchases` — every purchase the bridge has verified with its store, keyed by the SHA-256
-- of the store's purchase key (`app-store:<originalTransactionId>`, `play:<purchaseToken>`,
-- `steam:<steamid>:<dlcAppId>`), never the raw token. `license_id` is the licence the purchase
-- was bound to the first time it was seen; a later claim from any other licence is refused.
-- `state` is `active`, `pending`, `revoked` or `rejected`; `environment` the store's (`Production`,
-- `Sandbox`, `play-test`, `steam`). `detail_json` holds the non-secret ids the re-checks need.
--
-- `license_store_grants` — the effect on a licence: one row per (purchase, flag), `active` or
-- `revoked`. `core/payload.ts` reads the active rows as a layer of the licence document, after
-- the licence profiles and before the licence's own overrides, so an operator override wins.
CREATE TABLE IF NOT EXISTS dist_store_products (
  product          TEXT NOT NULL REFERENCES products(slug),
  store            TEXT NOT NULL CHECK (store IN ('app-store', 'play', 'steam')),
  store_product_id TEXT NOT NULL,
  deliverable_id   TEXT NOT NULL,
  flag             TEXT NOT NULL,
  source           TEXT NOT NULL DEFAULT 'admin' CHECK (source = 'admin'),
  modified_at      INTEGER NOT NULL,
  modified_by      TEXT NOT NULL,
  PRIMARY KEY (product, store, store_product_id)
);

CREATE TABLE IF NOT EXISTS dist_purchase_bindings (
  product    TEXT NOT NULL REFERENCES products(slug),
  binding_id TEXT NOT NULL,
  license_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (product, license_id),
  UNIQUE (product, binding_id)
);

CREATE TABLE IF NOT EXISTS dist_purchases (
  product           TEXT NOT NULL REFERENCES products(slug),
  store             TEXT NOT NULL CHECK (store IN ('app-store', 'play', 'steam')),
  purchase_key_hash TEXT NOT NULL,
  store_product_id  TEXT NOT NULL,
  license_id        TEXT NOT NULL,
  state             TEXT NOT NULL CHECK (state IN ('active', 'pending', 'revoked', 'rejected')),
  environment       TEXT NOT NULL,
  first_seen        INTEGER NOT NULL,
  last_verified     INTEGER NOT NULL,
  detail_json       TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (product, store, purchase_key_hash)
);

CREATE INDEX IF NOT EXISTS idx_dist_purchases_recheck
  ON dist_purchases (product, store, state, last_verified);

CREATE TABLE IF NOT EXISTS license_store_grants (
  product           TEXT NOT NULL REFERENCES products(slug),
  license_id        TEXT NOT NULL,
  flag              TEXT NOT NULL,
  store             TEXT NOT NULL CHECK (store IN ('app-store', 'play', 'steam')),
  purchase_key_hash TEXT NOT NULL,
  state             TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
  granted_at        INTEGER NOT NULL,
  revoked_at        INTEGER,
  PRIMARY KEY (product, store, purchase_key_hash, flag)
);

CREATE INDEX IF NOT EXISTS idx_license_store_grants_license
  ON license_store_grants (product, license_id, state);
