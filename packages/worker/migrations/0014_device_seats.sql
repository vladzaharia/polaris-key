-- R11-02 / R3-02 — an explicit seat ordinal so seat consumption can be made ATOMIC.
--
-- ONE statement per file (see 0013). The partial unique index that turns this column into a
-- DB-arbitrated seat lock lives in 0015_data_integrity.sql, which is fully idempotent, so a
-- failed replay of this file can never strand it.
ALTER TABLE devices ADD COLUMN seat_no INTEGER;
