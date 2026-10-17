-- I-11 rollback: run only after deploying a Worker that does not read account_deletions.
-- The pending requests are intentionally discarded; no account has been erased by this rollback.
DROP TABLE account_deletions;
