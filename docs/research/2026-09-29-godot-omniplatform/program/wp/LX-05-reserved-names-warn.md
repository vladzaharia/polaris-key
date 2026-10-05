# LX-05 Reserved entitlement names, warn phase: compatible-declaration rule, platform `licensing.reservedNames` setting, console list of registered products, djdl copy fix

| Field       | Value                                                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (phase A: independent fixes)                                    |
| Size        | 0.3–0.4 engineer-weeks                                                                                                     |
| Depends on  | none                                                                                                                       |
| Unblocks    | [PX-W13](PX-W13-passthrough-metadata.md), [LX-05b](LX-05b-reserved-names-error.md), [LX-09](LX-09-entitlement-resolver.md) |
| Role        | `pkey-implementer`                                                                                                         |
| Plan mode   | no                                                                                                                         |
| Gates       | rule 9 (validator rule, mutation table, JSON schema); drift gate (`--check`)                                               |
| Human input | none                                                                                                                       |
| Repo        | `vladzaharia/polaris-key`                                                                                                  |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **Owner (2026-10-05):** PX-W13's `reserved_display_name` rule follows this package's warn-then-enforce pattern and reuses its validator warning path, so PX-W13 depends on LX-05. No extra scope here.

## Goal

System entitlement names are reserved in warn mode: a compatible declaration stays valid forever, an incompatible one warns, the platform setting `licensing.reservedNames` (`warn`/`error`) exists, the console lists registered products, and djdl's `deviceLimit` copy is fixed.

## Why

System keys share the product flag namespace with no rule (G13, [S-19 §4.3](../../notes/S-19-licensing-model.md#43-gaps)); decision 15 reserves now with a warn window ([S-19 §10.3](../../notes/S-19-licensing-model.md#103-owner-decisions-recommended-defaults-in-bold) decision 15).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`; the `authoring-pkey-manifests` skill.
- [S-19 owner decisions](../../notes/S-19-licensing-model.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-19 §7.4](../../notes/S-19-licensing-model.md#74-combine-rules-entitlement-kinds-and-reserved-names), [S-19 §9](../../notes/S-19-licensing-model.md#9-phased-plan-and-work-packages) row LX-05.

## Scope

**In:**

- Validator rule (rule 9: rule, mutation entry, schema); platform registry entry; console list; djdl copy.

**Out** (and where it belongs instead):

- The error flip (→ LX-05b).

## Design notes

- Warn window: two minor releases or 60 days, whichever is later; LX-05b flips it.

## Corrections from the code (LX-05 implementation, 2026-10-04)

- **Setting key.** The A-13 platform registry (`packages/worker/src/core/platformSettings.ts`) keys
  every entry by its upper-snake `[vars]` name, so S-19's `licensing.reservedNames` is registered as
  **`LICENSING_RESERVED_NAMES`** (area `licensing`, `runtime` precedence, default `warn`; confirm
  L1 to `error`, L0 to `warn`). The registry had only `switch` and `integer` kinds; LX-05 adds a
  `choice` kind (worker, settings API, console row) for it.
- **Severity is passed in, not read by the validator.** `@polaris-key/manifest` is pure, so
  `validateManifestDocuments`, `validateIngestDocuments` and `parseManifest` take an optional
  `{ reservedNames: "warn" | "error" }` (default `warn`); the Worker's link, resync and platform
  deploy-hook ingest pass the platform setting. The console's catalog writes (Config's
  `PUT config/catalog`, manual product create) apply the same severity, so `error` cannot be
  bypassed through the console.
- **One module.** What is reserved and what is compatible lives only in
  `packages/shared-manifest/src/reservedNames.ts`; the Worker's `core/reservedNames.ts` answers the
  severity. The console list is `GET /manage/api/platform/reserved-names` (admin, narrative-only
  under rule 10) shown on Platform → Settings → Licensing.
- **Unknown reserved-prefix names.** A name under `app.` is compatible as a string (S-19 §7.4 "`app.*`
  semver string"); any other name under `license.` or `pkey.` that is not a system key has no
  compatible form and is reported. `examples` is allowed as a presentation field alongside the
  fields §7.4 lists.

## Steps

1. Rule and mutation entry.
2. Platform setting.
3. Console list.

## Acceptance criteria

- [ ] An incompatible declaration warns and a compatible one passes (test).
- [ ] Rule 9 mutation table entry exists.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/manifest test
mise exec node@22 -- pnpm --filter @polaris-key/worker test
```

## Hand-off

- LX-05b; LX-09 relies on reserved names.

The role agent sets `--set LX-05 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-05 done`.
