# LX-21 `reanchor: onRefresh` and the portal "Run this device on" route

| Field       | Value                                                                          |
| ----------- | ------------------------------------------------------------------------------ |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (phase C: the wire) |
| Size        | 0.3–0.4 engineer-weeks                                                         |
| Depends on  | [LX-10](LX-10-anchor-choice.md), [LX-17](LX-17-sdk-licenseid-audit.md)         |
| Unblocks    | none                                                                           |
| Role        | `pkey-implementer`                                                             |
| Plan mode   | no                                                                             |
| Gates       | rule 10 (OpenAPI + `routeCoverage`)                                            |
| Human input | none                                                                           |
| Repo        | `vladzaharia/polaris-key`                                                      |

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
