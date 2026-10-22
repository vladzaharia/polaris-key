-- Rollback of 0199_listing_truth_moves.sql. The ledger only records what the backfill job moved;
-- dropping it loses the job's own undo path (run `down` of `distribution.listing-truth` first if
-- any apply must be reverted), never the listing itself.
DROP TABLE IF EXISTS dist_listing_truth_moves;
