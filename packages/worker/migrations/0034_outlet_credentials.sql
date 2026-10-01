-- P5-01 — outlet-credential custody.
--
-- The credentials a store connector authenticates with (an App Store Connect `.p8` API key, an
-- App Store Server Notifications webhook secret, a Google service-account key, a Partner Center
-- client secret) live HERE and never in `product_secrets`. Edge-mint opens any `product_secrets`
-- row an operator marked `edge-mint` for any device of the product; a `.p8` stored there would be
-- one approval away from a public App Store Connect token mint. This table is unreachable from
-- `openProductSecret` and from edge-mint:
--
--   - by AAD: `enc_value_json` is sealed under `pkey:v2:<product>:outlet-credential:<credential_id>`,
--     so a blob copied into `product_secrets` does not open as a `product-secret`;
--   - by code: `core/outletCredentials.ts` is the only accessor, and
--     `test/outletCredentialReach.test.ts` refuses any importer outside the Distribution service,
--     `core/outletTokens.ts` and the Core admin handler.
--
-- Rows are written ONLY by a platform admin through the write-only admin API
-- (`PUT /manage/api/products/<slug>/outlet-credentials/<id>`), never from a `.pkey/` manifest, a
-- resync or a service ingest hook. Every open is audited (`outlet_credential.use`).
--
-- `meta_json` holds non-secret display fields only (key id, issuer id, client email, tenant id,
-- client id, seller id) so the console can list a credential without opening it.
-- `last_used_at` / `last_ok_at` / `last_error` are the health columns a connector reports through
-- `recordOutletCredentialResult`; `last_error` never carries a credential value.
--
-- Sealed under PLATFORM_KEK like `product_keys` and `product_secrets`, so the KEK re-seal sweep
-- (`GET|POST /manage/api/products/kek`) counts and re-seals it, and deleting a product deletes its
-- rows in the same batch.
CREATE TABLE IF NOT EXISTS outlet_credentials (
  product        TEXT NOT NULL REFERENCES products(slug),
  credential_id  TEXT NOT NULL,
  kind           TEXT NOT NULL,
  outlet_id      TEXT,
  enc_value_json TEXT NOT NULL,
  meta_json      TEXT NOT NULL DEFAULT '{}',
  status         TEXT NOT NULL DEFAULT 'active',
  created_at     INTEGER NOT NULL,
  created_by     TEXT NOT NULL,
  rotated_at     INTEGER,
  expires_at     INTEGER,
  last_used_at   INTEGER,
  last_ok_at     INTEGER,
  last_error     TEXT,
  PRIMARY KEY (product, credential_id)
);
