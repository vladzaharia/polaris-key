-- HA-05 (notes/S-20 §6.3, §6.4): pull on register and resync. The lead assigns the number at merge.
--
-- Five columns on `hosted_assets` (0078) that let a manifest pull run off the request path, on
-- the queue `pkey-assets-<env>` (`core/hostedAssetPulls.ts`):
--
--   wanted_ref       what the manifest declares for the slot NOW, canonical JSON
--                    `{"kind":"url"|"repo","src":…,"sha256"?:…}`; NULL for a slot no manifest
--                    names (an upload, a CI push, a release file). A console-claimed slot keeps
--                    it up to date, so Revert (HA-06) knows where the slot goes back to.
--   pulled_ref       the `wanted_ref` the stored copy was pulled for. `wanted_ref IS NOT
--                    pulled_ref` means a pull is owed: the slot keeps serving its old copy until
--                    the new one is ready.
--   source_blob      a repo source: the git blob SHA of the stored copy at `source_ref`'s commit,
--                    the change detector across commits (a resync at a new commit that leaves the
--                    file alone pulls nothing).
--   attempts         failed pulls since the last good one (exponential back-off, capped at 24 h).
--   next_attempt_at  when the next pull may be enqueued (epoch seconds); NULL means now. Set when
--                    a pull is enqueued too, so a second resync in quick succession does not
--                    enqueue the same pull twice.
--
-- Expand-only: nullable or defaulted columns nothing older reads. Rollback: the columns can stay
-- (unread); a rebuild without them is a separate migration.

ALTER TABLE hosted_assets ADD COLUMN wanted_ref TEXT;
ALTER TABLE hosted_assets ADD COLUMN pulled_ref TEXT;
ALTER TABLE hosted_assets ADD COLUMN source_blob TEXT;
ALTER TABLE hosted_assets ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hosted_assets ADD COLUMN next_attempt_at INTEGER;

-- The nightly re-check reads owed pulls across products, oldest-due first.
CREATE INDEX IF NOT EXISTS hosted_assets_pull_due
  ON hosted_assets (next_attempt_at)
  WHERE wanted_ref IS NOT NULL;
