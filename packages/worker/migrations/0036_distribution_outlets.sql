-- P2b-02 — `.pkey/distribution`: outlets and transports (README §3.8).
--
-- Both tables are Distribution's (`TABLE_OWNERS.distribution` in the docs generator), written by
-- its `manifestIngest` hook on link and resync, in the same batch as the rest of the ingest.
--
-- `dist_outlets` — one row per outlet the product declares (or the implicit `direct` outlet a
-- product with Distribution on and no document gets).
--
--   - `identity_json` and `listing_json` are MANIFEST-owned: every resync rewrites them. The
--     listing is stored MERGED (the document's listing with the outlet's own override over it).
--   - `capabilities_json` / `capabilities_source` are OPERATOR-owned and never written by an
--     ingest. `capabilities_source = 'default'` means the per-kind default table applies
--     (`services/distribution/capabilities.ts`); `'admin'` means an operator narrowed it, and
--     `capabilities_json` holds the narrowing. A manifest cannot express capabilities at all
--     (`capabilities_not_manifest_writable`).
--   - `removed_at` is set when a resync no longer finds the outlet; the row is never deleted,
--     because availability history (P2b-03) refers to it. Re-declaring the outlet clears it.
--   - `modified_at` moves only when an ingest actually changes the row, so a second resync of the
--     same manifest is a no-op.
--
-- `dist_transports` — the resolved transport for every (declared deliverable, live outlet) pair:
-- `transports.deliverables.<id>.<outlet>`, then `transports.packs.<outlet>` for a pack, then
-- `transports.default`, then `pkey-cdn`. Replaced wholesale by each ingest. `config_json` is
-- reserved for per-transport settings (P4-05, P4-14) and NULL today.
CREATE TABLE IF NOT EXISTS dist_outlets (
  product             TEXT NOT NULL REFERENCES products(slug),
  outlet_id           TEXT NOT NULL,
  kind                TEXT NOT NULL,
  identity_json       TEXT NOT NULL DEFAULT '{}',
  capabilities_json   TEXT,
  listing_json        TEXT,
  capabilities_source TEXT NOT NULL DEFAULT 'default',
  removed_at          INTEGER,
  created_at          INTEGER NOT NULL,
  modified_at         INTEGER NOT NULL,
  PRIMARY KEY (product, outlet_id)
);

CREATE TABLE IF NOT EXISTS dist_transports (
  product        TEXT NOT NULL REFERENCES products(slug),
  deliverable_id TEXT NOT NULL,
  outlet_id      TEXT NOT NULL,
  transport      TEXT NOT NULL,
  config_json    TEXT,
  PRIMARY KEY (product, deliverable_id, outlet_id)
);
