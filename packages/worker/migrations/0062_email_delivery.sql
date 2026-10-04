-- I-18 (notes/S-16 §5.4 item 4, §9 risk 9): email delivery operations for the one shared sign-in
-- sender. Two Core-owned tables (`TABLE_OWNERS.core` in the docs generator), written and read only
-- by `src/core/emailDelivery.ts`.
--
-- email_suppressions: recipients that must never be mailed again (hard bounces, complaints, the
-- provider's own suppressions, operator entries). Keyed by the recipient's PEPPERED hash
-- (`recipientHash`: `hashKey("email:" + trimmed lower-case address, KEY_HASH_PEPPER)`), so the
-- table holds no address and a listing yields nothing usable (R12-04). Platform-wide by design: a
-- bounce or a complaint hurts the one shared sender whichever product's mail caused it.
--
--   reason      hard_bounce | complaint | provider | operator
--   created_at  epoch seconds of the latest event
--   expires_at  epoch seconds after which the entry no longer applies; NULL = permanent
--               (complaints, provider and operator entries; a hard bounce lasts 90 days)
--
-- email_product_caps: a product's own daily cap on passthrough sign-in mail ("<App> via Polaris
-- Key"), overriding the deploy's `EMAIL_PRODUCT_DAILY_CAP` var and the code default (500). Platform
-- mail is never capped. Product-first like every tenant table (R11-05).
CREATE TABLE IF NOT EXISTS email_suppressions (
  address_hash TEXT PRIMARY KEY,
  reason       TEXT NOT NULL
                 CHECK (reason IN ('hard_bounce', 'complaint', 'provider', 'operator')),
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER
);

CREATE TABLE IF NOT EXISTS email_product_caps (
  product     TEXT PRIMARY KEY,
  daily_cap   INTEGER NOT NULL CHECK (daily_cap > 0),
  modified_at INTEGER NOT NULL
);
