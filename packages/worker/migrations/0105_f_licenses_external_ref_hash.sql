-- LX-08 (plans/LX-01.md §6.1, notes/S-19 §7.2): the hashed purchase key, payment or subscription
-- id a sale-minted licence came from. Unique per (product, source) through the partial index
-- `idx_licenses_ext_ref` (0105_m). NULL for every licence today.
--
-- ONE statement per file (R11-04).
ALTER TABLE licenses ADD COLUMN external_ref_hash TEXT;
