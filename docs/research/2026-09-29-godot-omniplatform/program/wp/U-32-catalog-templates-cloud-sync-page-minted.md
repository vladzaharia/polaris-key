# U-32 Catalog templates, Cloud Sync page, minted-token wizard and the Integration config card

| Field       | Value                                                                                                                                                                                                                             |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | U: Cloud Sync (S-17) (DX consolidation G: Managed config and Cloud Sync)                                                                                                                                                          |
| Size        | 0.8–1.1 engineer-weeks                                                                                                                                                                                                            |
| Depends on  | [U-30](U-30-config-types-in-app-visibility-in-one.md), [U-31](U-31-minted-tokens-carry-their-recipe.md), [U-06](U-06-sdk-settings-node-python.md), [ST-39](ST-39-wizard-kit.md), [ST-41](ST-41-integration-page-overview-card.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                                                                                                                                            |
| Role        | `pkey-implementer`                                                                                                                                                                                                                |
| Plan mode   | no                                                                                                                                                                                                                                |
| Gates       | `console-csp-parity`                                                                                                                                                                                                              |
| Human input | none                                                                                                                                                                                                                              |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                         |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **CFG-07** in [Track G, Managed config and Cloud Sync](../../../2026-10-07-dx-consolidation/tracks.md#g-managed-config-and-cloud-sync).

## Goal

Catalog templates, Cloud Sync page, minted-token wizard and the Integration config card, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **CFG-07** in [Track G, Managed config and Cloud Sync](../../../2026-10-07-dx-consolidation/tracks.md#g-managed-config-and-cloud-sync). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.1, §3.2); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/config-cloudsync.md`](../../../2026-10-07-dx-consolidation/audits/config-cloudsync.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track G, Managed config and Cloud Sync](../../../2026-10-07-dx-consolidation/tracks.md#g-managed-config-and-cloud-sync): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.1, §3.2, for **CFG-07**.
- [`audits/config-cloudsync.md`](../../../2026-10-07-dx-consolidation/audits/config-cloudsync.md), for file and line evidence.

## Scope

**In:**

- Catalog templates keyed by platform (game, desktop, CLI, web) offered at create and on an empty catalog; the Cloud Sync page as Setup and Usage, replacing the read-only Data page; the minted-token wizard; the Managed config and Cloud Sync card on Integration with SP-33a snippets (setting, synced setting, secret, minted token, sync status, save), Verified from the config and sync bits of sdk_sightings. The create-time bootstrap is ST-42's.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track G (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **CFG-07**; DX consolidation G: Managed config and Cloud Sync.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] A new product reaches a published catalog from a template in one step
- [ ] The card renders on ST-41
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set U-32 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set U-32 done`.
