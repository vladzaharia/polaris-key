-- LX-08 (plans/LX-01.md §2.5, §6.1): the licence that replaced this one (trial to paid, an
-- upgrade by a new licence, an enrolled free licence attached to an account that holds a better
-- one, LX-10). It may be set while the licence is still active. NULL for every licence today.
--
-- ONE statement per file (R11-04).
ALTER TABLE licenses ADD COLUMN superseded_by TEXT;
