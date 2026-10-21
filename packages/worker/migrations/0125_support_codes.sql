-- I-41: readable support codes (core/accounts/supportCodes.ts).
--
-- The code a person reads out to a product's support: nine characters from a 30-symbol alphabet
-- without lookalikes, stored without dashes (`ABC234XYZ`) and shown as `ABC-234-XYZ`. It names ONE
-- person to ONE product: `subject` is that product's pairwise subject, the id the developer's
-- Users page and the signed licence carry. It is an identifier, no credential.
--
--   code        the nine characters, globally unique (30^8, about 6.6e11, random; the ninth symbol is a check), so a lookup by code alone
--               finds the row and the retry-on-collision stays rare;
--   product     the product the code was minted for. A lookup is always checked against it;
--   subject     the person's subject for that product. An absorbed (merged) subject still resolves
--               through the alias table, and the erasure paths delete the row with the subject;
--   created_at  epoch seconds.
--
-- UNIQUE (product, subject): one stable code per person per product. Created lazily on the first
-- ask, never backfilled. Owned by `identity` (TABLE_OWNERS).
CREATE TABLE IF NOT EXISTS support_codes (
  code       TEXT PRIMARY KEY,
  product    TEXT NOT NULL,
  subject    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (product, subject)
);
