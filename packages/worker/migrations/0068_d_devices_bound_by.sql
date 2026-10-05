-- I-05 (plans/I-04.md §6.1, §8 Q3): how a device row was last bound: `key` (licence-key entry),
-- `enroll` (an auto-issued licence), `register` (a licence-less device token), `signin` (an
-- account or product sign-in) or `store` (a storefront purchase binding). NULL on every row
-- written before this migration, which reads as "never released by a sign-out": sign-out frees a
-- device only when it was bound by `signin` and runs the signed-out account's licence.
--
-- ONE statement per file (R11-04).
ALTER TABLE devices ADD COLUMN bound_by TEXT
  CHECK (bound_by IS NULL OR bound_by IN ('key', 'enroll', 'register', 'signin', 'store'));
