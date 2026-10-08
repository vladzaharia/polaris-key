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

UPDATE blob_refs
   SET ref_kind = 'package-file'
 WHERE ref_kind = 'artifact'
   AND EXISTS (SELECT 1 FROM release_artifacts a
                WHERE a.product = blob_refs.product
                  AND a.kind = 'package'
                  AND a.release_id || '/' || a.artifact_id = blob_refs.ref_id)
   AND NOT EXISTS (SELECT 1 FROM blob_refs b2
                    WHERE b2.product = blob_refs.product AND b2.storage_key = blob_refs.storage_key
                      AND b2.ref_kind = 'package-file' AND b2.ref_id = blob_refs.ref_id);
