# LX-44 License console v2: Tiers and Entitlements pages

| Field       | Value                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (DX consolidation E: Licensing model)                                            |
| Size        | 0.8–1.2 engineer-weeks                                                                                                                      |
| Depends on  | [LX-34](LX-34-entitlement-catalog-in-licensing-tier.md), [LX-35](LX-35-add-on-definitions-grantaddon.md), [ST-07](ST-07-settings-row-v2.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [LX-43](LX-43-licensing-presets-1-x-helper-new-major.md)                                            |
| Role        | `pkey-implementer`                                                                                                                          |
| Plan mode   | no                                                                                                                                          |
| Gates       | `console-csp-parity`                                                                                                                        |
| Human input | none                                                                                                                                        |
| Repo        | `vladzaharia/polaris-key`                                                                                                                   |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **LX-44** in [Track E, Licensing model](../../../2026-10-07-dx-consolidation/tracks.md#e-licensing-model).

## Goal

License console v2: Tiers and Entitlements pages, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **LX-44** in [Track E, Licensing model](../../../2026-10-07-dx-consolidation/tracks.md#e-licensing-model). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.2, §4.4); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: the [decision record](../../../2026-10-07-dx-consolidation/integration.md) (no audit names **LX-44**).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track E, Licensing model](../../../2026-10-07-dx-consolidation/tracks.md#e-licensing-model): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.2, §4.4, for **LX-44**.

## Scope

**In:**

- Tier record in four groups (Duration, Limits, Includes, Profile); rank by drag (list order); fingerprint mode visible with a SourceBadge; License -> Entitlements page (catalog plus platform entitlements, each shown only while its service is on); the Add-ons collection linked. Absorbs LX-14's tier half.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track E (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **LX-44**; DX consolidation E: Licensing model.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] A tier is edited on one record
- [ ] Platform entitlements hidden while their service is off
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set LX-44 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-44 done`.
