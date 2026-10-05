# LX-05 Reserved entitlement names, warn phase: compatible-declaration rule, platform `licensing.reservedNames` setting, console list of registered products, djdl copy fix

| Field       | Value                                                                                   |
| ----------- | --------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (phase A: independent fixes) |
| Size        | 0.3–0.4 engineer-weeks                                                                  |
| Depends on  | none                                                                                    |
| Unblocks    | [LX-05b](LX-05b-reserved-names-error.md), [LX-09](LX-09-entitlement-resolver.md)        |
| Role        | `pkey-implementer`                                                                      |
| Plan mode   | no                                                                                      |
| Gates       | rule 9 (validator rule, mutation table, JSON schema); drift gate (`--check`)            |
| Human input | none                                                                                    |
| Repo        | `vladzaharia/polaris-key`                                                               |

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
