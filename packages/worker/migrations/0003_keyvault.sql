-- KEK-based key custody. Per-product signing keys + secrets are envelope-encrypted in
-- D1 under ONE platform KEK (env.PLATFORM_KEK). The private key never leaves D1 in
-- plaintext; loadProduct opens it per request via AES-256-GCM (see src/keyvault.ts).

-- Sealed Ed25519 signing keys, versioned per product by `kid` (rotation-ready). Exactly one
-- row per product should be status='active'; loadProduct fails CLOSED if none exists.
CREATE TABLE IF NOT EXISTS product_keys (
  product          TEXT NOT NULL REFERENCES products(slug),
  kid              TEXT NOT NULL,
  alg              TEXT NOT NULL DEFAULT 'Ed25519',
  -- Raw 32-byte Ed25519 public key (base64url) — the JWKS / verify side.
  public_b64url    TEXT NOT NULL,
  -- Sealed PKCS#8 PEM (JSON: { v, iv, ct }), opened under env.PLATFORM_KEK.
  enc_private_json TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'active',  -- active | retired
  created_at       INTEGER NOT NULL,
  rotated_at       INTEGER,
  PRIMARY KEY (product, kid)
);

-- Sealed per-product secrets (OIDC client secret, edge-mint key material, …) keyed by name.
CREATE TABLE IF NOT EXISTS product_secrets (
  product        TEXT NOT NULL REFERENCES products(slug),
  name           TEXT NOT NULL,
  -- Sealed plaintext (JSON: { v, iv, ct }), opened under env.PLATFORM_KEK.
  enc_value_json TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  modified_at    INTEGER NOT NULL,
  PRIMARY KEY (product, name)
);

ALTER TABLE products ADD COLUMN release_source TEXT;
ALTER TABLE edge_mint_config ADD COLUMN audience TEXT;
