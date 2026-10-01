-- P2b-01 — turn the new `distribution` service on wherever Release is on.
--
-- Every product with Release enabled serves `/release/dl` today, and P2b-04 moves byte serving
-- into Distribution. The chain is release ← distribution ← update (`distribution_requires_release`,
-- `update_requires_distribution`), so a product with Release and Update on would otherwise read
-- as incoherent the moment this build ships, and lose its downloads when P2b-04 lands. Setting
-- `distribution` on keeps exactly today's behaviour.
--
-- WHATEVER `services_source` SAYS. An admin-owned row is an operator's claim over the set they
-- could see; Distribution did not exist when they claimed it, so turning it on alongside Release
-- is preserving their choice, not overriding it. A manifest-owned row is re-derived on its next
-- resync anyway (a `releases` manifest enables all three; a manifest naming `release` + `update`
-- must add `distribution` before it next validates — the backfill keeps it serving meanwhile).
--
-- Guards, so the statement can never damage a row:
--   - `json_valid` first: an unreadable blob is left alone and keeps reading as the defaults
--     (`parseServices` falls back), and `json_extract` on it would abort the whole statement.
--   - `$.release.enabled` must be JSON true (`json_extract` returns 1 for it).
--   - `$.distribution` must be ABSENT. A row that already says anything about distribution —
--     written by this build, or a deliberate `false` — is not touched. That also makes the file
--     idempotent: a replay finds every row it set already carrying the key.
--
-- `json(...)` so the value is stored as an object, not as a JSON string. `json_set` appends the
-- key; order inside the blob is irrelevant (`serializeServices` rewrites it canonically on the
-- next write).
UPDATE products
   SET services_json = json_set(services_json, '$.distribution', json('{"enabled":true}'))
 WHERE services_json IS NOT NULL
   AND CASE
         WHEN json_valid(services_json) THEN
           json_type(services_json) = 'object'
           AND json_extract(services_json, '$.release.enabled') = 1
           AND json_type(services_json, '$.release.enabled') = 'true'
           AND json_type(services_json, '$.distribution') IS NULL
         ELSE 0
       END;
