-- SEC-DST-1: a package version's files move from the `artifact` blob-ref kind to `package-file`
-- (core/blobs.ts PACKAGE_FILE_REF). The blob route reads an `artifact` ref as an app artifact under
-- the app's delivery mode, which made every package file a public bearer capability named by its
-- sha256; `package-file` refs authorise nothing on that route (the package feeds serve them under
-- their own access ladder).
--
-- Backfill: every `artifact` ref whose id (`<release_id>/<artifact_id>`) names a release_artifacts
-- row of kind 'package' (written only by the package ingest, with artifact ids `file:<name>`).
-- Idempotent: a second run finds no `artifact` ref left to move. No new table, TABLE_OWNERS is
-- unchanged. Apply BEFORE the code ships: the new code ignores `artifact` refs of packages only
-- by their kind, and the old kind would keep serving until this runs.

-- Uncorrelated subqueries: one ephemeral index, not a scan of release_artifacts per ref.
UPDATE blob_refs
   SET ref_kind = 'package-file'
 WHERE ref_kind = 'artifact'
   AND (product, ref_id) IN (SELECT product, release_id || '/' || artifact_id
                               FROM release_artifacts WHERE kind = 'package')
   AND (product, storage_key, ref_id) NOT IN (SELECT product, storage_key, ref_id
                                                FROM blob_refs WHERE ref_kind = 'package-file');
