---
"@polaris-key/cli": minor
"@polaris-key/manifest": minor
---

Fix the `pkey init` scaffold and the validate/link disagreement.

`@polaris-key/manifest` exports `validateIngestDocuments`, the one rule for document presence:
`.pkey/schema` is required at ingest even when Config is off (`missing_schema`), and
`parseManifest` and `pkey validate` both use it, so a manifest that validates now links. A new
warning, `tier_ignored_field`, flags a tier `deviceLimit` (ignored; use `policyDeviceLimit`) and
a tier `maxOfflineDays` (sets the licence expiry, `policyExpiryDays`, not offline grace).

`pkey init` always writes `schema.yaml` (an empty catalog when `config` is not selected), scaffolds
the tier as `policyDeviceLimit: 5` with no expiry, and drops the unread
`licensing.keyActivation`. `pkey doctor` prints the enabled services from the discovery
document's `services` block.

Existing products created with the old scaffold have tiers with `maxOfflineDays: 14`, which
expire their licences after 14 days: the new warning is how their owners find out. Replace
`maxOfflineDays` with `policyExpiryDays` (or drop it for a non-expiring tier) and `deviceLimit`
with `policyDeviceLimit`.

Ingest behaviour for Config-off products is unchanged: a present catalog is only required to
normalise, its content is still shape-validated only when Config is on.
