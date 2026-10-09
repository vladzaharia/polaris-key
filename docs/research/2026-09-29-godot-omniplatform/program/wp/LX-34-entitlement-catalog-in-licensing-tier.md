# LX-34 Entitlement catalog in Licensing; tier entitlements; platform entitlements (absorbs CFG-06)

| Field       | Value                                                                                                                                                                                                                                          |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (DX consolidation E: Licensing model)                                                                                                                                               |
| Size        | 1.2–1.6 engineer-weeks                                                                                                                                                                                                                         |
| Depends on  | [LX-33](LX-33-licence-tier-platform-default-every.md), [P0-49](P0-49-data-migration-runner-dry-run-report.md)                                                                                                                                  |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [U-28](U-28-one-config-chain-default-profile-one.md), [LX-09](LX-09-entitlement-resolver.md), [LX-35](LX-35-add-on-definitions-grantaddon.md), [LX-44](LX-44-license-console-v2-tiers-entitlements.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                             |
| Plan mode   | no                                                                                                                                                                                                                                             |
| Gates       | `rule-9`                                                                                                                                                                                                                                       |
| Human input | none                                                                                                                                                                                                                                           |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                      |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **LX-34** in [Track E, Licensing model](../../../2026-10-07-dx-consolidation/tracks.md#e-licensing-model).

- Clears its entries in `packages/admin/test/copy.debt.json` (ST-37's console copy ledger).

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/U-01b.md`](../plans/U-01b.md) §11: `pkey.cloudSync.bytes` becomes a platform `quantity` entitlement (default 256 MiB, shown while Cloud Sync is on).

## Goal

Entitlement catalog in Licensing; tier entitlements; platform entitlements (absorbs CFG-06), as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **LX-34** in [Track E, Licensing model](../../../2026-10-07-dx-consolidation/tracks.md#e-licensing-model). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.1, §3.2, §4.2, §6); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/backlog-sweep.md`](../../../2026-10-07-dx-consolidation/audits/backlog-sweep.md), [`audits/config-cloudsync.md`](../../../2026-10-07-dx-consolidation/audits/config-cloudsync.md), [`audits/entitlements-subscriptions.md`](../../../2026-10-07-dx-consolidation/audits/entitlements-subscriptions.md), [`audits/licensing-core.md`](../../../2026-10-07-dx-consolidation/audits/licensing-core.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track E, Licensing model](../../../2026-10-07-dx-consolidation/tracks.md#e-licensing-model): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.1, §3.2, §4.2, §6, for **LX-34**.
- [`audits/backlog-sweep.md`](../../../2026-10-07-dx-consolidation/audits/backlog-sweep.md), for file and line evidence.
- [`audits/config-cloudsync.md`](../../../2026-10-07-dx-consolidation/audits/config-cloudsync.md), for file and line evidence.
- [`audits/entitlements-subscriptions.md`](../../../2026-10-07-dx-consolidation/audits/entitlements-subscriptions.md), for file and line evidence.
- [`audits/licensing-core.md`](../../../2026-10-07-dx-consolidation/audits/licensing-core.md), for file and line evidence.

## Scope

**In:**

- licensing.entitlements[] (manifest, rule 9) with kind feature | quantity | consumable; tiers.entitlements_json and manifest licensing.tiers[].entitlements and fingerprintMode; a platform entitlement registry (reservedNames.ts becomes service-aware rows: channels, app.minVersion/maxVersion, deviceLimit, license.tier/tierLabel, pkey.cloudSync.bytes; a key shows in editors only while its service is on); /config/schema keeps serving flag rows generated from Licensing's declarations permanently, kind additive (no wire change, C-09); Config editors drop flags; userGrant/grantLabel retired; profile entitlement buckets migrate to tiers and licence-attached ones to licence entitlement overrides through a P0-49 job of its own. Independent of U-28 and of owner decision 1.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track E (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **LX-34**; DX consolidation E: Licensing model.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 2 mockup item(s):** `licenses.tiers`, `entitlements.catalog`.

## Acceptance criteria

- [ ] /config/schema byte-identical except the additive kind member
- [ ] SDK transcripts unchanged
- [ ] Validator warns, then refuses, flags in profiles
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `features/licensing/{entitlements, add-ons}`; `features/managed-config/catalog` (flags leave); `help/library` (add-ons).
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen:transcripts -- --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set LX-34 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-34 done`.
