-- LX-08 (plans/LX-01.md §6.1, notes/S-19 §7.2): a licence's kind. `base` is every licence today
-- and the default; an `addon` licence carries no seats, is never an anchor and contributes only
-- while a contributing `base` licence is usable. Nothing writes `addon` until LX-25 defines what
-- entering such a key does (plans/LX-01.md §8 Q8).
--
-- ONE statement per file (R11-04): a bare ADD COLUMN cannot be made idempotent in SQLite, so a
-- replay fails here and strands nothing after it. Old Worker safe: it never names the column.
ALTER TABLE licenses ADD COLUMN kind TEXT NOT NULL DEFAULT 'base' CHECK (kind IN ('base', 'addon'));
