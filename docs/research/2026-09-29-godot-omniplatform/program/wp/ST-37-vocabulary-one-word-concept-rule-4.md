# ST-37 Vocabulary: one word per concept (rule 4)

| Field       | Value                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | ST: Settings, access control and console shell (DX consolidation A: Ground truth, decisions and quick wins)                                       |
| Size        | 0.3–0.5 engineer-weeks                                                                                                                            |
| Depends on  | none                                                                                                                                              |
| Unblocks    | [P0-41](P0-41-living-admin-md-portal-md-ux-rows.md), [P0-51](P0-51-1-0-readiness-review.md), [A-19](A-19-one-channel-catalogue-tools-channels.md) |
| Role        | `pkey-implementer`                                                                                                                                |
| Plan mode   | no                                                                                                                                                |
| Gates       | `docs-links`                                                                                                                                      |
| Human input | none                                                                                                                                              |
| Repo        | `vladzaharia/polaris-key`                                                                                                                         |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **OB-01** in [Track A, Ground truth, decisions and quick wins](../../../2026-10-07-dx-consolidation/tracks.md#a-ground-truth-decisions-and-quick-wins).

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/I-27.md`](../plans/I-27.md) §12: the glossary rows, "Account profile" included.
- [`plans/CM-29.md`](../plans/CM-29.md) §10: six features; the glossary's "Commerce (a fact, not a switch)" becomes a service.

## Goal

Vocabulary: one word per concept (rule 4), as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **OB-01** in [Track A, Ground truth, decisions and quick wins](../../../2026-10-07-dx-consolidation/tracks.md#a-ground-truth-decisions-and-quick-wins). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§2, §3.2, §4.2); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/backlog-sweep.md`](../../../2026-10-07-dx-consolidation/audits/backlog-sweep.md), [`audits/release-distribution.md`](../../../2026-10-07-dx-consolidation/audits/release-distribution.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track A, Ground truth, decisions and quick wins](../../../2026-10-07-dx-consolidation/tracks.md#a-ground-truth-decisions-and-quick-wins): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §2, §3.2, §4.2, for **OB-01**.
- [`audits/backlog-sweep.md`](../../../2026-10-07-dx-consolidation/audits/backlog-sweep.md), for file and line evidence.
- [`audits/release-distribution.md`](../../../2026-10-07-dx-consolidation/audits/release-distribution.md), for file and line evidence.

## Scope

**In:**

- integration.md §2 into start/concepts.md: Feature, Integration, Verified, licence in an account / waiting / floating, Automatic grant, Tier, Add-on (sub-licence), Entitlement, Limits, Duration, Trial, Keeps the last version, Subscription, Access policy, Access (the product page), Profile, Setting/Secret/Minted token, Editable/Read-only/Hidden, Channel, Storefront, Sales, Offer/SKU, Release track, Install source, Packages, Updates, Pack, Connection, Sign-in surface, Screen name, Member/Role/Area, Personal and Service token; 'terms' kept for legal terms only; SETUP D1 amended; ADMIN and EXPERIENCE pointer blocks; console copy rules ('outlet', 'storefront feed', 'grant' and 'capability' leave the UI). Identifiers stay.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track A (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **OB-01**; DX consolidation A: Ground truth, decisions and quick wins.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Every UI word maps to a kept identifier
- [ ] A copy lint flags 'outlet' and 'grant' in console strings
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
mise exec node@22 -- pnpm --filter @polaris-key/docs build
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set ST-37 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-37 done`.
