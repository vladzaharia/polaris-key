-- PS-04 (notes/S-21 §6.4, §6.6, owner decisions 6 and 12): the Polaris Key storefront's library
-- entries and its daily analytics.
--
-- `library_entries`: a product in an account's library WITHOUT a licence. "Add to library" on the
-- `open` obtain path (License off for the product, every download open) writes one row and no
-- licence; nothing binds a device. `GET /api/library` lists the row as `kind: "entry"` until the
-- account holds a licence for the product, which hides it. `DELETE /api/library/<p>` removes it
-- (entries only: a licence leaves the library only by the existing detach). The storefront never
-- offers or counts a product an entry holds, as it never offers a held licence's.
--
--   account_id  INTERNAL: the global account id never leaves the Worker's Identity and Core code
--               (S-16 §5.1). Account deletion deletes the account's rows; a merge moves them to
--               the survivor (the survivor's own row wins).
--   product     the product's slug. Product deletion deletes its rows (`deleteProduct`).
--   via         why the entry exists: `open` only. S-22 adds none: a purchase creates a licence.
--   added_at    epoch seconds.
--
-- `storefront_daily`: one aggregate row per (product, UTC day, path kind): how many accounts saw
-- the product (`impressions`: `GET /api/discover` and the storefront product page, deduplicated
-- per account per day through `storefront_seen`), how many added it (`adds`: a claim that created
-- the licence or the entry), and how many of those added licences had their first device bound
-- within seven days (`activations`, counted on the ADD's day and path kind, so `activations /
-- adds` is a rate). `path_kind` is the first path's kind (`group`, `auto_issue`, `open`, and the
-- later kinds), or `link` for an audience-`everyone` listing with nothing to add. No account id.
--
-- `storefront_seen`: the two-day impression dedupe. `account_key` is HMAC-SHA-256 under the day's
-- salt (itself derived from the deployment's `KEY_HASH_PEPPER` and the day) of the account id,
-- truncated: it names no account, and the nightly sweep deletes every row older than yesterday.
-- No account id.
--
-- Identity owns all three (TABLE_OWNERS). Expand-only: nothing older reads them, and every
-- statement is IF NOT EXISTS, so a replay converges (R11-04).
CREATE TABLE IF NOT EXISTS library_entries (
  account_id TEXT NOT NULL,
  product    TEXT NOT NULL,
  via        TEXT NOT NULL CHECK (via IN ('open')),
  added_at   INTEGER NOT NULL,
  PRIMARY KEY (account_id, product)
);
-- Product deletion removes a product's entries.
CREATE INDEX IF NOT EXISTS idx_library_entries_product
  ON library_entries(product);

CREATE TABLE IF NOT EXISTS storefront_daily (
  product     TEXT NOT NULL,
  day         TEXT NOT NULL,
  path_kind   TEXT NOT NULL,
  impressions INTEGER NOT NULL DEFAULT 0,
  adds        INTEGER NOT NULL DEFAULT 0,
  activations INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (product, day, path_kind)
);

CREATE TABLE IF NOT EXISTS storefront_seen (
  product     TEXT NOT NULL,
  day         TEXT NOT NULL,
  account_key TEXT NOT NULL,
  PRIMARY KEY (product, day, account_key)
);
