-- LX-28 (notes/S-24 §6.1): the batch a licence was created in. NULL for every licence not created
-- by `POST …/license/batches` (every licence before this migration, and every single create).
-- Batch licences keep `origin = 'admin'` (the origin trigger of 0015 is not widened) and are
-- floating at creation (no name, no email).
--
-- ONE statement per file (R11-04): a bare ADD COLUMN cannot be made idempotent in SQLite, so a
-- replay fails here and strands nothing after it. The index is in 00XX_c.
ALTER TABLE licenses ADD COLUMN batch_id TEXT;
