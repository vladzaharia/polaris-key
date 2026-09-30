# P0-07 Fix the `pkey init` scaffold and the validate/link disagreement

| Field       | Value                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------ |
| Phase       | P0: Hygiene and unblockers                                                                             |
| Size        | 0.25 engineer-weeks                                                                                    |
| Depends on  | none                                                                                                   |
| Unblocks    | [P0-09](P0-09-service-table.md)                                                                        |
| Role        | `pkey-implementer`                                                                                     |
| Plan mode   | no                                                                                                     |
| Gates       | CLI and manifest tests; rule 9 parity stays green (one new warning code); generated `validation-codes` |
| Human input | none                                                                                                   |
| Repo        | `vladzaharia/polaris-key`                                                                              |

## Goal

`pkey init` followed by `pkey validate` produces a manifest that links on the first try and whose
tiers mean what the scaffold intends (a five-device licence that does not expire). `pkey validate`
refuses exactly what link refuses about missing documents, and warns when a tier uses a field that
is ignored or misread.

## Why

Report [§9.1](../../README.md#91-polaris-key-worth-fixing-regardless-of-godot) issue #13 and
[notes/A3 §1.1](../../notes/A3-admin-dx.md#11-end-to-end-flow-as-built) ("Onboarding DX papercuts"):

- The tier scaffold writes `deviceLimit: 5` and `maxOfflineDays: 14`
  (`packages/cli/src/manifest.ts:233-239`). `normalizeTier` ignores `deviceLimit` (it reads
  `policyDeviceLimit`) and maps `maxOfflineDays` to **`policyExpiryDays`**
  (`packages/shared-manifest/src/index.ts:1666-1675`), so a scaffolded product's licences expire
  after 14 days. `licensing.keyActivation` (`manifest.ts:224-225`) is read by nothing.
- `parseManifest` (used by link and resync) refuses a missing `.pkey/schema` outright
  (`index.ts:1472-1473`), but `validateManifestDocuments` (used by `pkey validate`) asks for it
  only when Config is on (`index.ts:579-588`), and `pkey init --modules releases` writes no
  `schema.yaml` (`manifest.ts:148-152`). A release-only product passes `pkey validate` and fails at
  link. The docs already say two files are always required
  (`packages/docs/src/content/docs/start/quickstart.md:17-21`); the tool does not enforce it.

## Read first

- `AGENTS.md` (rule 9) and the `authoring-pkey-manifests` skill (steps 1, 2 and 5).
- `packages/cli/src/manifest.ts` (whole file), `packages/cli/src/index.ts:157-211`
  (`cmdValidate`, `cmdDoctor`), `packages/cli/test/cli.test.ts`.
- `packages/shared-manifest/src/index.ts:450-600` (`validateManifestDocuments` start, the
  `missing_schema` rule), `1460-1530` (`parseManifest`), `1650-1680` (`normalizeTier`).
- `packages/shared-manifest/test/schema-parity.test.ts` (the `missing_schema` entry at line 276).

## Scope

**In:**

- **One rule for document presence.** Export one function from `@polaris-key/manifest` that
  checks what ingest requires (both `product` and `schema` present, then
  `validateManifestDocuments`). `parseManifest` calls it; `validateLoadedManifest` in the CLI calls
  it. A missing schema is reported with the existing code `missing_schema` and the message
  "`.pkey/schema` is required at ingest even when Config is off; an empty catalog is
  `schemaVersion: 1` with no entries." The worker's link and resync behaviour does not change.
- **Scaffold.** `pkey init` always writes `schema.yaml`: the example entries when `config` is
  selected, otherwise `schemaVersion: 1` and `catalog: []`. The tier becomes
  `policyDeviceLimit: 5` with no expiry field; drop `maxOfflineDays` from the tier (the product
  keeps `defaultMaxOfflineDays: 14`) and drop `licensing.keyActivation`.
- **Warning** (rule 9: a new code needs a mutation-table entry): proposed
  `tier_ignored_field`, raised for `deviceLimit` on a tier ("ignored; use `policyDeviceLimit`") and
  for `maxOfflineDays` on a tier ("sets the licence expiry, `policyExpiryDays`, not offline grace").
  A warning, not an error, so existing manifests keep linking.
- Remove the unused `enabledModules`, `collectRequiredSecrets`, `add`, `stringAt`
  (`packages/cli/src/manifest.ts:324-364`); drop the v2 `modules` field from `cmdDoctor`'s
  discovery type (`index.ts:201-205`) and print the enabled services from `body.services` instead.
- Update the skill (step 1: `schema.yaml` is always written) and
  `packages/docs/src/content/docs/build/manifest/authoring.md` where it describes the scaffold.

**Out** (and where it belongs instead):

- Scaffolding canonical service slugs instead of the legacy module names, and generating the CLI
  module list (→ [P0-09](P0-09-service-table.md), which replaces `manifest.ts:9-14,72-78`).
- Editor schema headers that assume `node_modules`, and publishing the packages publicly so a
  Godot repo can install the CLI (→ P2-06, which ships the CLI to CI; P1-12 for Godot docs).
- Making link accept a missing schema. Rejected: the docs and skill already promise "two files
  are always required", and resync writes `product_schema` from the catalog unconditionally.

## Design notes

- Keep `missing_schema`'s existing Config-on path working; the ingest check wraps it, so the code
  is reported once, not twice.
- `validation-codes.mdx` is generated from the validator source and carries messages
  (`packages/docs/src/content/docs/reference/validation-codes.mdx:82`); regenerate it.
- The mutation table must gain a case for `tier_ignored_field` (`schema: "accepts"`, since the
  JSON schema tolerates unknown tier keys) and a case for "Config off, schema missing" if the
  ingest check is exercised there.
- Existing products created with the old scaffold have 14-day expiring tiers in their repos. The
  warning is how their owners find out; mention it in the PR description and the changeset.

## Steps

1. Add the ingest-presence function in `shared-manifest`; switch `parseManifest` to it.
2. Add `tier_ignored_field`, its mutation entries, and regenerate the reference page.
3. Change the CLI: `validateLoadedManifest`, `initManifest`, `productYaml`, `schemaYaml`; remove dead
   code; fix `cmdDoctor`.
4. Tests, docs, skill, changeset for `@polaris-key/cli` and `@polaris-key/manifest`.

## Acceptance criteria

- [x] CLI test: `pkey init --modules releases` writes `product.yaml`, `schema.yaml` and
      `release.yaml`, and `pkey validate` exits 0.
- [x] CLI test: deleting `schema.yaml` from that directory makes `pkey validate` exit 1 with
      `missing_schema`, matching what `parseManifest` returns for the same files.
- [x] Manifest test: the scaffolded tier normalises to `policyDeviceLimit: 5`,
      `policyExpiryDays: null`.
- [x] Manifest test: a tier with `deviceLimit` or `maxOfflineDays` yields `tier_ignored_field`
      warnings and no error.
- [x] `schema-parity.test.ts` passes with the new entry; `gen:check` passes.
- [x] The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/cli test
mise exec node@22 -- pnpm --filter @polaris-key/manifest test
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- linkRepo manifest
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
```

## Hand-off

P0-09 changes the scaffold's module block to canonical slugs from the service table; it should
build on the scaffold this package leaves. P2-06 (`pkey release …`) and P1-12 (Godot onboarding
docs) assume `pkey init && pkey validate` produces a linkable manifest. When done:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P0-07 done`.

## Implementation notes

- The ingest rule is `validateIngestDocuments` (`@polaris-key/manifest`). It takes a product that
  may be `undefined`, so "product and schema present" is one rule: a missing product is reported
  as `missing_product` (a second new code, with its own mutation-table entry) alongside a missing
  schema. `parseManifest` formats whole-document errors as `file: message` (pointer `/` is
  dropped) so the existing worker test expectations (`schema: ... required`) hold; the CLI prints
  `file/`-prefixed lines as before.
- `validateManifestDocuments` keeps its Config-conditional behaviour for author-side callers; both
  entry points share one emit site for `missing_schema`, so the generated reference has one row.
- With Config off, a present schema is now shape-validated at ingest (previously it was only
  normalised), which is what link already relied on.
