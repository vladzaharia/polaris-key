# LX-21 `reanchor: onRefresh` and the portal "Run this device on" route

| Field       | Value                                                                          |
| ----------- | ------------------------------------------------------------------------------ |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (phase C: the wire) |
| Size        | 0.3–0.4 engineer-weeks                                                         |
| Depends on  | none                                                                           |
| Unblocks    | none                                                                           |
| Role        | `pkey-implementer`                                                             |
| Plan mode   | no                                                                             |
| Gates       | rule 10 (OpenAPI + `routeCoverage`)                                            |
| Human input | none                                                                           |
| Repo        | `vladzaharia/polaris-key`                                                      |

## Sign-in alignment (2026-10-05): SIGN-IN.md

[`docs/design/SIGN-IN.md`](../../../../design/SIGN-IN.md) is the canonical sign-in experience, and `plans/I-04.md`
§F (the reconciliation, with delegated decisions 16–24) is its wire counterpart. Where this brief
differs from either, they win. Copy comes from SIGN-IN.md §5.2 (`signin.*`, US "license").
**No device-wire change** (`PROTOCOL_VERSION` 4, `corpusVersion` 2). For this package:

- Until LX-21, sign-in's LicenseChoiceStep is the way to change a device's license (sign out, sign in, choose; SIGN-IN.md D-42). "Run this device on" reuses `LicenseChoiceView`, including `access` and `current`.

## Consolidation 2026-10-07

> **Closed 2026-10-07 (DX consolidation): merged into [LX-10](LX-10-anchor-choice.md).** The id stays in the graph as `dropped` so it
> is not reused; do not build this package. Its scope moves to [LX-10](LX-10-anchor-choice.md).

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **merge** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> The reanchor: onRefresh setting goes; the useful behaviour is LX-10's fixed re-home rule and a portal device action.

- Dependencies cleared on closing (they were LX-10 and LX-17), so nothing in the graph waits on or through a closed package.

## Goal

`licensing.reanchor: onRefresh` works (silent re-bind on refresh when the anchor became unusable), and the portal's "Run this device on" route takes effect at the next refresh.

## Why

Decision 10: `onRefresh` only after LX-17 shows every SDK tolerates a `licenseId` change, or LX-19 fixes them ([S-19 §10.3](../../notes/S-19-licensing-model.md#103-owner-decisions-recommended-defaults-in-bold) decision 10).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-19 owner decisions](../../notes/S-19-licensing-model.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-19 §7.5](../../notes/S-19-licensing-model.md#75-anchor-selection-seats-and-re-anchoring), [S-19 §9](../../notes/S-19-licensing-model.md#9-phased-plan-and-work-packages) row LX-21.

## Scope

**In:**

- Document-route re-bind; portal route with OpenAPI and `routeCoverage`.

**Out** (and where it belongs instead):

- SDK fixes (→ LX-19).

## Design notes

- Re-anchoring changes config as well as entitlements; the audit entry says so.

## Steps

1. Re-bind.
2. Route.

## Acceptance criteria

- [ ] An expired anchor re-binds on refresh under `onRefresh` only (test).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
```

## Hand-off

- None.

The role agent sets `--set LX-21 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-21 done`.
