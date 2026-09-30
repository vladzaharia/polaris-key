-- P0-01 — copy hand-set operator keys out of `artifact_policy_json` into `operator_policy_json`.
--
-- Rows written before 0022_c may hold `requireSparkleSignature` / `minimumSystemVersion` inside
-- `artifact_policy_json` (set by an operator editing the row directly). The readers now look
-- only at `operator_policy_json`, so without this copy those values would silently revert to the
-- defaults on deploy.
--
-- `json_remove` (not `json_extract`) so a JSON `false` stays a JSON boolean; `json_extract`
-- would turn it into the integer 0. The CASE guards `json_extract` from a malformed blob, which
-- would otherwise abort the whole statement: unreadable JSON is left alone and keeps reading as
-- the fail-safe defaults.
--
-- Idempotent: `operator_policy_json IS NULL` makes a replay a no-op for every row it already
-- copied, so this file is safe to re-run.
UPDATE release_config
   SET operator_policy_json = json_remove(
         artifact_policy_json,
         '$.channels',
         '$.architectures',
         '$.requireDmg',
         '$.requireCli',
         '$.allowAmbiguousAssets'
       )
 WHERE operator_policy_json IS NULL
   AND CASE
         WHEN json_valid(artifact_policy_json) THEN
           json_extract(artifact_policy_json, '$.requireSparkleSignature') IS NOT NULL
           OR json_extract(artifact_policy_json, '$.minimumSystemVersion') IS NOT NULL
         ELSE 0
       END;
