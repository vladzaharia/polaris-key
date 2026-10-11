-- PX-W19 (PORTAL.md §4.26, the Passkeys rows): the name the person gave a passkey, so they can
-- tell their authenticators apart ("Work laptop"). Nullable: NULL means unnamed, and the list falls
-- back to the browser it was added from. It is a label only: never read by verification, never put
-- in an email, and shown to its owner as text. The row moves whole in a merge and back by id in its
-- undo, so the name travels with it. Identity owns the table.
--
-- ONE statement per file (R11-04).
ALTER TABLE account_passkeys ADD COLUMN name TEXT;
