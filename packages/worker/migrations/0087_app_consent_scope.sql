-- PX-W13 (plans/PX-W13.md §2.3, §6; WIRE-CONTRACT-V4 §12.7.3): the scope an app consent covers.
--
-- `account_product_grants` is app consent (I-05, D19/D22): an account's "Continue to <App>" and
-- the profile claims it agreed to share. `scope_hash` is the lowercase hex SHA-256 of the
-- canonical JSON `{claims, services, v: 1}` the person consented to. The consent view
-- (`GET /api/signin/requests/:handle/consent`) compares it with the current scope: a different
-- hash (a new claim, Cloud Sync turned on) asks again; a new anchor licence or new grants do not
-- (§8 Q5). I-08 writes it on Continue. NULL means a consent recorded before scopes were, which
-- asks once more to record one.
--
-- Expand-only and reversible: one nullable column. A Worker deployed before this migration never
-- names it. TABLE_OWNERS is unchanged (identity).

ALTER TABLE account_product_grants ADD COLUMN scope_hash TEXT;
