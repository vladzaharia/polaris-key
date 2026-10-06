-- I-07 (PORTAL.md §4.10): when the "add another way to sign in" card was last shown to this
-- account. It is offered after the first sign-in, and again only if the account still has a
-- single sign-in method 30 days later. NULL: never shown. Identity owns the table.
--
-- ONE statement per file (R11-04).
ALTER TABLE accounts ADD COLUMN nudge_shown_at INTEGER;
