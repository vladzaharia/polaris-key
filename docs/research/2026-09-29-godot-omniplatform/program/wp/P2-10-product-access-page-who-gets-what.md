# P2-10 Product Access page: who gets what (absorbs LX-37)

| Field       | Value                                                                                                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P2: Release truth, publishing and release tracks (DX consolidation I: Packages, updates and packs)                                                                          |
| Size        | 1–1.4 engineer-weeks                                                                                                                                                        |
| Depends on  | [ST-07](ST-07-settings-row-v2.md), [F-34](F-34-feeds-that-provision-themselves.md), [LX-36](LX-36-access-policy-license-access-absorbs-ps.md), [ST-39](ST-39-wizard-kit.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [P4-34](P4-34-one-click-pack-gate-packs-without-update.md)                                                                          |
| Role        | `pkey-implementer`                                                                                                                                                          |
| Plan mode   | no                                                                                                                                                                          |
| Gates       | `console-csp-parity`                                                                                                                                                        |
| Human input | none                                                                                                                                                                        |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                   |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **UC-03** in [Track I, Packages, updates and packs](../../../2026-10-07-dx-consolidation/tracks.md#i-packages-updates-and-packs).

## Goal

Product Access page: who gets what (absorbs LX-37), as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **UC-03** in [Track I, Packages, updates and packs](../../../2026-10-07-dx-consolidation/tracks.md#i-packages-updates-and-packs). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.2, §4.2, §4.4, §5); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/licensing-core.md`](../../../2026-10-07-dx-consolidation/audits/licensing-core.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track I, Packages, updates and packs](../../../2026-10-07-dx-consolidation/tracks.md#i-packages-updates-and-packs): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.2, §4.2, §4.4, §5, for **UC-03**.
- [`audits/licensing-core.md`](../../../2026-10-07-dx-consolidation/audits/licensing-core.md), for file and line evidence.

## Scope

**In:**

- One product page, Access, in one vocabulary (Public, Signed in, Customers, Holds <entitlement>): automatic licences (license.access: Nobody / Everyone / Rules with labels and a persona preview, the editor LX-36 defines), anonymous devices, Discover visibility (PS-12), and the delivery gates for update checks, app downloads, packs, package feeds and per-package gates; License -> Enrollment, License -> Settings (LicenseSettingsPage) and Distribution -> Access redirect here; Identity -> Sign-in loses its group table; the Polaris Key 'Ways to add' becomes a summary; readiness errors; the access sections on the feed and Update pages become read-only with a link.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track I (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **UC-03**; DX consolidation I: Packages, updates and packs.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] One page answers 'who gets what, automatically and to download'
- [ ] No access control duplicated on another page; retired routes redirect
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set P2-10 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P2-10 done`.
