-- SP-08 — canonical platform values `tvos`, `visionos` and `watchos` (WIRE-CONTRACT-V4 §5.2).
-- DATA ONLY: no column, index or table changes.
--
-- `PLATFORM_SPELLINGS` gained the three values, so the Worker now stores `tvOS` as `tvos`,
-- `visionOS` as `visionos` and `watchOS` as `watchos` (`src/core/clientMetadata.ts`). Before, it
-- stored them as sent (rule 3). This converges those rows, in the pattern of
-- `0040_canonical_client_metadata.sql`. Each statement is idempotent, and replaying the file
-- changes nothing (`test/canonicalClientMetadata.test.ts`). SQLite's `lower()` folds ASCII only,
-- which is §5.2's folding rule.

UPDATE devices SET platform = 'tvos'
  WHERE lower(platform) = 'tvos' AND platform <> 'tvos';
UPDATE devices SET platform = 'visionos'
  WHERE lower(platform) = 'visionos' AND platform <> 'visionos';
UPDATE devices SET platform = 'watchos'
  WHERE lower(platform) = 'watchos' AND platform <> 'watchos';
