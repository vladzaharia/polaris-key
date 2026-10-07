-- HA-12 (plans/HA-11.md Q5, plans/HA-12.md §3 and §6): the product's manifest-declared
-- presentation, `.pkey/product` `presentation` (HA-04's `ManifestPresentation`: the icon ref and
-- the light and dark accents), as the canonical JSON the manifest writers store
-- (`core/products.ts` `serializePresentation`). Manifest-only: link (`linkRepo`), every
-- resync (`resyncRepo`) and the system product's deploy hook (`linkSystemProduct`) write it in
-- their existing batch, NULL when the manifest declares none; the console never writes it (the
-- `core.presentation` setting's column adapter is decode-only).
--
-- Discovery reads it for `core.presentation` (WIRE-CONTRACT-V4 §5.5): the accent and accent dark.
-- The icon ref itself is never emitted; the icon comes from the slot's hosted copy.
--
-- Expand-only: no backfill (the next resync fills it; until then the listing's `tintColor` and
-- `listing.icon` still resolve), no new table, so TABLE_OWNERS is unchanged. A code rollback
-- leaves the column unread.

ALTER TABLE products ADD COLUMN presentation_json TEXT;
