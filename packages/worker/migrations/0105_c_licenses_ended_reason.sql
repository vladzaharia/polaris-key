-- LX-08 (plans/LX-01.md §2.5, §6.1): why a disabled licence ended: revoked, refunded, chargeback
-- or superseded, written in the same statement that disables it (LX-12). NULL for every licence
-- today. The vocabulary is a trigger (`trg_licenses_ended_reason_{ins,upd}`, 0105_m), so the
-- column needs no rebuild when it widens.
--
-- ONE statement per file (R11-04).
ALTER TABLE licenses ADD COLUMN ended_reason TEXT;
