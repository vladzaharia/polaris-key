-- I-05 (plans/I-04.md §6.2): the device binding S-17 needs. `devices.subject` holds the pairwise
-- subject signed in on this device for its product, never the account id, so no product-tenant
-- row carries the global id. Set by Core's activation path when an account sign-in calls it;
-- key entry never sets it; it is never signed. Cleared by Core's clearing hook (sign-out, sign
-- out everywhere, account disable or deletion, per-product removal, relink), never by a plain
-- licence detach (S-17 §5.8 item 2). Cloud Sync's principal is this column and nothing else.
--
-- ONE statement per file (R11-04).
ALTER TABLE devices ADD COLUMN subject TEXT;
