# LX-19 Six SDKs on the licensing wire (one wave with LX-20)

| Field       | Value                                                                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (phase C: the wire)                                                                      |
| Size        | 1.6–2.25 engineer-weeks                                                                                                                             |
| Depends on  | [LX-18](LX-18-licensing-wire.md), [LX-17](LX-17-sdk-licenseid-audit.md), [SP-35](SP-35-sdk-api-registry-api-json-0-9.md), [UK-03](UK-03-ui-core.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [CM-15](CM-15-sdk-purchase-handoff.md)                                                                      |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                                                                                |
| Plan mode   | yes: executes the approved [`plans/LX-18.md`](../plans/LX-18.md) (no separate plan)                                                                 |
| Gates       | plan mode; all six SDKs (`parity:check`); every conformance runner; visual baselines (both themes, phone)                                           |
| Human input | none                                                                                                                                                |
| Repo        | `vladzaharia/polaris-key`                                                                                                                           |

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track K, Corpus lane (wire trains, serial)](../../../2026-10-07-dx-consolidation/tracks.md#k-corpus-lane-wire-trains-serial)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> One SDK wave with LX-20 on SP-35's names (entitlements.has/value/grants, quantity, duration via term(), consume and acknowledge for consumables); kit badges render through ui-core in the rebuilt kits.

- Title: was "Six SDKs and four UI kits on the licensing wire: `isEntitled` gated on usable and expiry, `entitlement()`, `grants()`, `licenseExpiresAt()`, status reasons, LX-17 fixes, migration guide and release notes".
- Depends on: added SP-35 and UK-03.

## Goal

All six SDKs and four UI kits implement the licensing wire: `isEntitled` false unless the gate is usable and unexpired, `entitlement()`, `grants()`, `licenseExpiresAt()`, status reasons, the LX-17 fixes, plus a migration guide and release notes.

## Why

Decision 14 makes `isEntitled` false whenever the gate is not usable, in all six SDKs ([S-19 §10.3](../../notes/S-19-licensing-model.md#103-owner-decisions-recommended-defaults-in-bold) decision 14).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode).
- [S-19 owner decisions](../../notes/S-19-licensing-model.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-19 §7.10](../../notes/S-19-licensing-model.md#710-wire-impact-plan-mode), [S-19 §7.11](../../notes/S-19-licensing-model.md#711-console-portal-and-sdk-surface), [S-19 §9](../../notes/S-19-licensing-model.md#9-phased-plan-and-work-packages) row LX-19.
- `program/plans/LX-18.md`.

## Scope

**In:**

- Node, React (client-core), Python, Swift, Kotlin, Godot; UI kits; LX-17 fixes; migration guide; release notes.

**Out** (and where it belongs instead):

- Commerce clients (→ LX-20).

## Design notes

- Behaviour is defined by the corpus and transcripts; verdicts must match byte for byte.

## Steps

1. client-core first, then each SDK.
2. UI kits.
3. Docs.

## Acceptance criteria

- [ ] Every conformance runner passes.
- [ ] `parity.json` updated in every SDK.
- [ ] Migration guide published.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm parity:check
```

## Hand-off

- LX-21 may use `onRefresh` once LX-17's failures are fixed here.

The role agent sets `--set LX-19 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-19 done`.
