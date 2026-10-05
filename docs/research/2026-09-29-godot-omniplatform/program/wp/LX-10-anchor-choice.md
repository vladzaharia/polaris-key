# LX-10 Anchor choice at activation (`anchorPolicy: rank-first`): sign-in, attach, Discover and base claim; licence-less devices; enroll supersede and grant re-homing on attach

| Field       | Value                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (phase B: the model, server-only)                                                      |
| Size        | 0.5–0.7 engineer-weeks                                                                                                                            |
| Depends on  | [LX-09](LX-09-entitlement-resolver.md), [I-09](I-09-key-entry-attach.md)                                                                          |
| Unblocks    | [LX-11](LX-11-commerce-rework.md), [LX-14](LX-14-console-licensing.md), [LX-15](LX-15-portal-licensing.md), [LX-21](LX-21-reanchor-on-refresh.md) |
| Role        | `pkey-implementer`                                                                                                                                |
| Plan mode   | no                                                                                                                                                |
| Gates       | THREAT-MODEL                                                                                                                                      |
| Human input | none                                                                                                                                              |
| Repo        | `vladzaharia/polaris-key`                                                                                                                         |

## Goal

Activation chooses the anchor by `anchorPolicy` (default `rank-first`) for sign-in, attach, Discover and base claims, handles licence-less devices, supersedes an enrolled free licence on attach and re-homes its grants; I-09's inline rule is replaced by `chooseAnchor`.

## Why

Decision 3 accepted `rank-first` ([S-19 §10.3](../../notes/S-19-licensing-model.md#103-owner-decisions-recommended-defaults-in-bold) decision 3); I-09 carries steps 1–3 inline until this lands (`program/plans/I-04.md` amendment).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-19 owner decisions](../../notes/S-19-licensing-model.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-19 §7.5](../../notes/S-19-licensing-model.md#75-anchor-selection-seats-and-re-anchoring), [S-19 §9](../../notes/S-19-licensing-model.md#9-phased-plan-and-work-packages) row LX-10.

## Scope

**In:**

- `chooseAnchor` in Core; `rank-first`, `most-free-seats`, `oldest`; auto-issue fallback; enroll supersede; grant re-homing.

**Out** (and where it belongs instead):

- `reanchor: onRefresh` (→ LX-21).
- `reason: no_base_licence` on the wire (→ LX-18).

## Design notes

- Default `reanchor: onActivation` (decision 10); licence-less devices: `licensed`/`entitled` gates require an anchor (decision 23).

## Steps

1. `chooseAnchor` with tests.
2. Replace I-09's inline code.
3. Supersede and re-homing.

## Acceptance criteria

- [ ] The anchor order matches §7.5 for each policy (tests).
- [ ] Attach of an enrolled free licence supersedes it and keeps its grants (test).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
```

## Hand-off

- LX-11, LX-14, LX-15, LX-21.

The role agent sets `--set LX-10 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-10 done`.
