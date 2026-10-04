-- PX-W5 (docs/design/PORTAL.md §10.2 G7, G22): two per-product portal switches.
--
-- `key_reissue_enabled` — G7, "Get a new key". A customer who has lost or leaked their license key
-- can mint a replacement from the portal (`POST /api/licenses/<product>/<id>/keys`); the old key
-- stops activating new devices, devices already activated keep working. It is a per-product OPT-IN
-- (default 0): whether a key may be replaced without the developer is the developer's call, and a
-- product that hands its keys out through a store or prints them on cards may not want it.
--
-- `claim_by_key` — the S-16 safety default (owner, 2026-10-04): a license that carries an email
-- attaches only to an account with that email verified, not by presenting its key, unless the
-- product sets `claimByKey`. Default 0 is the safe default the owner confirmed. The activate
-- preview (`POST /api/activate/preview`, G22) and the claim (`POST /api/claim/license-key`) both
-- read it through one evaluator, so the preview can never promise what the claim then refuses.
--
-- Expand-only: two nullable-free columns with constant defaults on an existing table, so a Worker
-- deployed before this migration keeps working unchanged (it never names the columns), and a
-- row written by that Worker reads back with both switches off — the conservative answer.
--
-- Rollback: a pre-PX-W5 Worker ignores both columns, so no SQL is needed. To drop them anyway:
--   ALTER TABLE portal_product_settings DROP COLUMN key_reissue_enabled;
--   ALTER TABLE portal_product_settings DROP COLUMN claim_by_key;

ALTER TABLE portal_product_settings ADD COLUMN key_reissue_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE portal_product_settings ADD COLUMN claim_by_key INTEGER NOT NULL DEFAULT 0;
