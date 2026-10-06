-- A-18j (notes/S-15 §7.4, A-18d's rule "every output is previewed and accepted before any push;
-- none is pushed unseen"): the console's slot board records which bytes of a listing asset the
-- operator looked at and accepted.
--
-- `accepted_sha256` is the digest of the bytes accepted, so a re-derived output (new bytes, a new
-- `sha256`) is unaccepted again without any write here: an asset is accepted exactly when
-- `accepted_sha256 = sha256`. `accepted_at` (epoch seconds) and `accepted_by` (the session's
-- subject) say when and by whom. An asset the operator uploaded in the console (`source =
-- 'admin'`) is theirs and counts as accepted.
--
-- The storefront pushes (`services/distribution/storefronts/`) send only accepted assets. Nothing
-- here is ever deleted; acceptance is cleared only by new bytes.
ALTER TABLE dist_listing_assets ADD COLUMN accepted_sha256 TEXT;
ALTER TABLE dist_listing_assets ADD COLUMN accepted_at INTEGER;
ALTER TABLE dist_listing_assets ADD COLUMN accepted_by TEXT;
