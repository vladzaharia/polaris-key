-- ST-01a (notes/S-18 §2.1, §4.3, §4.14): the last manifest applied to each product.
--
-- Nothing in D1 recorded what manifest was last applied: `product_sync_state.commit_sha` names the
-- push that TRIGGERED a sync (any branch touching `.pkey/`), not the commit whose `.pkey/` was
-- applied, and a manual resync records NULL. Revert-to-manifest (ST-01b), the drift view (ST-17)
-- and the settings backfill (ST-01c) all need the applied manifest, so every apply path writes one
-- row here IN THE SAME `db.batch` as the apply:
--
--   * `resync`      — `resyncRepo` (webhook or manual), files fetched at one pinned commit;
--   * `link`        — `linkRepo`, files fetched at one pinned commit;
--   * `deploy-hook` — `linkSystemProduct` from `POST /webhooks/deploy`, `applied_sha` = the
--                     deploy's `PKEY_GIT_SHA`;
--   * `backfill`    — reserved for ST-01c (the first snapshot of a product not applied since).
--
-- One row per product, latest only: history lives in the per-field audit rows (ST-01b).
--
-- `applied_sha`  the commit every document was fetched AT, resolved by GitHub from the
--                DB-configured repository's default branch (never caller-supplied, R6-05); NULL
--                only for a legacy/backfilled row or a deploy hook with no `PKEY_GIT_SHA`.
-- `files_sha256` lowercase hex SHA-256 over the raw documents (see `core/manifestSnapshot.ts`
--                for the canonical encoding), for change detection.
-- `manifest_json` the normalised ParsedManifest that was applied. Manifests carry secret NAMES
--                only, never values, so this column holds no secret material.
--
-- Size: each document is capped at MAX_REPO_FILE_BYTES (128 KiB) at the fetch and 64 KiB decoded
-- at the parse; `test/manifestSnapshot.test.ts` stores and reads back a snapshot built from four
-- maximum-size documents.
--
-- Expand-only: a new table. A Worker deployed before this migration never names it.
--
-- Rollback: a pre-ST-01a Worker ignores the table, so no SQL is needed. To drop it anyway:
--   DROP TABLE product_manifest_snapshot;

CREATE TABLE IF NOT EXISTS product_manifest_snapshot (
  product        TEXT PRIMARY KEY REFERENCES products(slug) ON DELETE CASCADE,
  applied_sha    TEXT NULL,
  applied_at     INTEGER NOT NULL,
  origin         TEXT NOT NULL CHECK (origin IN ('resync','link','deploy-hook','backfill')),
  files_sha256   TEXT NOT NULL,
  manifest_json  TEXT NOT NULL
);
