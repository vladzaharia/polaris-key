# P0-47 Quick wins: console and portal (week 0)

| Field       | Value                                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------------------- |
| Phase       | P0: Hygiene, unblockers and code quality (DX consolidation A: Ground truth, decisions and quick wins) |
| Size        | 0.6–1 engineer-weeks                                                                                  |
| Depends on  | [ST-36](ST-36-owner-polish-portal-fixes-simple-product.md)                                            |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                |
| Role        | `pkey-implementer`                                                                                    |
| Plan mode   | no                                                                                                    |
| Gates       | `console-csp-parity`                                                                                  |
| Human input | none                                                                                                  |
| Repo        | `vladzaharia/polaris-key`                                                                             |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **TrackA-QW1** in [Track A, Ground truth, decisions and quick wins](../../../2026-10-07-dx-consolidation/tracks.md#a-ground-truth-decisions-and-quick-wins).

## SDK usability review (2026-10-08)

Accepted changes from the [SDK usability review](../../../2026-10-08-sdk-usability/README.md) §10.1. Where they differ from the text below, they win.

- React's snippet also shows `<LicenseGate>` and declares the version; the Kotlin snippet uses `PolarisKeyAndroid.client`; the two docs links per SDK in today's quick start go through `DOCS_LINKS`.

## Goal

Quick wins: console and portal (week 0), as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **TrackA-QW1** in [Track A, Ground truth, decisions and quick wins](../../../2026-10-07-dx-consolidation/tracks.md#a-ground-truth-decisions-and-quick-wins). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: the "Quick wins" sections of the [audits](../../../2026-10-07-dx-consolidation/audits/) (each item in the scope carries its file and line).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track A, Ground truth, decisions and quick wins](../../../2026-10-07-dx-consolidation/tracks.md#a-ground-truth-decisions-and-quick-wins): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md), for **TrackA-QW1**.
- The "Quick wins" sections of the [audits](../../../2026-10-07-dx-consolidation/audits/).

## Scope

**In:**

- Each under a day, on top of ST-36: React snippets carry trust pins (A/console/pages/core/sdkQuickStart.ts:172-193, sdkConfig.ts renderReact); the lock bug in LicenseConfig.tsx:118-125; the dead 'Auto-issue in Enrollment' link (pages/identity/SignIn.tsx:340-348); LicenseSettingsPage marks its no-op settings pending; core.adminGroup input hidden and labelled not enforced; portal LicenseCard 'Updates included ... renew' copy (LicenseCard.tsx:174-180 after ST-36) until LX-41; Halt everywhere's dialog tells operators to halt in Google Play and pause the phased release in App Store Connect (copy only; the store halts are A-24's); Update -> Feed endpoints scoped to shipped platforms (update/FeedPage.tsx:499-508); Matrix and Override migration nav items hidden; feed access Token and Licensed collapsed into Customers (feeds/model.ts:90-102; Entitled is F-34's migration); the one-option Upstream section removed (FeedSettings.tsx:124).

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track A (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **TrackA-QW1**; DX consolidation A: Ground truth, decisions and quick wins.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Each item lands with a unit or e2e assertion
- [ ] No behaviour change beyond the listed fixes
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set P0-47 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P0-47 done`.
