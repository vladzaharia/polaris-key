-- LX-08 (plans/LX-01.md §6.1, notes/S-19 §7.2 and §7.7): the licensing model's commerce tables.
--
-- Owner (TABLE_OWNERS): Distribution, all three, written only by
-- `services/distribution/commerce/**`. Expand-only: every statement is `IF NOT EXISTS`, and a
-- Worker deployed before this migration never names them. There is no `dist_commerce_settings`
-- table: `restorePolicy` and `transferCooldownDays` live per store in the existing connector
-- settings (plans/LX-01.md §8 Q5, confirmed by LX-11).

-- What a mapped store product grants: many keys per store product (S-19 G4). It succeeds
-- `dist_store_products.flag`, which stays and keeps being written until LX-16. The backfill
-- (00XX_m) writes one row per mapping's flag; the admin mapping write keeps them in step.
CREATE TABLE IF NOT EXISTS dist_store_product_entitlements (
  product          TEXT NOT NULL REFERENCES products(slug),
  store            TEXT NOT NULL CHECK (store IN ('app-store', 'play', 'steam')),
  store_product_id TEXT NOT NULL,
  key              TEXT NOT NULL,
  value_json       TEXT NOT NULL DEFAULT 'true',
  PRIMARY KEY (product, store, store_product_id, key)
);

-- One purchase binding per HOLDER (an account or a licence), handed to the store before a
-- purchase, so a purchase can be held by an account rather than a licence (LX-11). The existing
-- `dist_purchase_bindings` stays the source for licence holders until LX-11 reads this table
-- first. Empty until LX-11.
CREATE TABLE IF NOT EXISTS dist_holder_bindings (
  product     TEXT NOT NULL REFERENCES products(slug),
  holder_kind TEXT NOT NULL CHECK (holder_kind IN ('account', 'license')),
  holder_id   TEXT NOT NULL,
  binding_id  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (product, holder_kind, holder_id),
  UNIQUE (product, binding_id)
);

-- A holder binding that now resolves to another holder (an absorbed account's binding after an
-- account merge, LX-13), so purchases made under it reach the survivor. Empty until LX-11/LX-13.
CREATE TABLE IF NOT EXISTS dist_binding_aliases (
  product     TEXT NOT NULL REFERENCES products(slug),
  binding_id  TEXT NOT NULL,
  holder_kind TEXT NOT NULL CHECK (holder_kind IN ('account', 'license')),
  holder_id   TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (product, binding_id)
);

CREATE INDEX IF NOT EXISTS idx_dist_binding_aliases_holder
  ON dist_binding_aliases (product, holder_kind, holder_id);
