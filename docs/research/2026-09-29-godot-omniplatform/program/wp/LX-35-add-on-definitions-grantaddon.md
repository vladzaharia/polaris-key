# LX-35 Add-on definitions and grantAddOn

| Field       | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (DX consolidation E: Licensing model)                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Size        | 1–1.4 engineer-weeks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Depends on  | [LX-34](LX-34-entitlement-catalog-in-licensing-tier.md), [P0-20](P0-20-split-identity-oidc-ts-extract-issuance.md), [P0-49](P0-49-data-migration-runner-dry-run-report.md)                                                                                                                                                                                                                                                                                                                                                               |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [P4-34](P4-34-one-click-pack-gate-packs-without-update.md), [D-05](D-05-diceroll-after-p6.md), [LX-11](LX-11-commerce-rework.md), [LX-18](LX-18-licensing-wire.md), [LX-25](LX-25-redeem-codes.md), [CM-23](CM-23-console-commerce-offers-purchases-sales.md), [CM-24](CM-24-one-steam-ownership-engine-absorbs-ps-07.md), [LX-36](LX-36-access-policy-license-access-absorbs-ps.md), [LX-42](LX-42-quantities-consumables-required.md), [LX-44](LX-44-license-console-v2-tiers-entitlements.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Plan mode   | no                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Gates       | none beyond the green gate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Human input | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **LX-35** in [Track E, Licensing model](../../../2026-10-07-dx-consolidation/tracks.md#e-licensing-model).

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/CM-20.md`](../plans/CM-20.md) §14: `grantAddOn` takes the purchase reference (`external_ref_hash` and the grant id); it exports its backfill's find-or-create add-on for a key set, which LX-11's job and legacy mapping write call; it moves `applyStoreGrant`'s `grants` write and the catch-up projection onto add-ons (§6.3).

## Goal

Add-on definitions and grantAddOn, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **LX-35** in [Track E, Licensing model](../../../2026-10-07-dx-consolidation/tracks.md#e-licensing-model). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§1.2, §3.1, §3.2, §4.2); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/entitlements-subscriptions.md`](../../../2026-10-07-dx-consolidation/audits/entitlements-subscriptions.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track E, Licensing model](../../../2026-10-07-dx-consolidation/tracks.md#e-licensing-model): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §1.2, §3.1, §3.2, §4.2, for **LX-35**.
- [`audits/entitlements-subscriptions.md`](../../../2026-10-07-dx-consolidation/audits/entitlements-subscriptions.md), for file and line evidence.

## Scope

**In:**

- licensing.addons[] (rule 9, claimable) and a License-owned addons table; grants.addon_id, required for every grant; a template is a label plus entitlements, or units for a consumable (a deviceLimit add-on is a seat pack); grantAddOn(licence, addon, source) in core/licensing/issue.ts; the resolver reads add-on keys live, never a grant's own key snapshot; console Add-ons collection and record (Sold as, Comp to..., holders). Backfill through a P0-49 job (C-49 extended): one add-on per distinct key set across store mappings (consuming dist_store_product_entitlements), provisioning grants and raw-key comps (a one-off comp becomes a licence entitlement override). Its migration ships its own down script; LX-08's 0105_licensing.down.sql is invalid after it (P0-24 ladder).

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track E (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **LX-35**; DX consolidation E: Licensing model.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Grants are licence-held and reference an add-on (no account or store holder writes, no add-on-less grant)
- [ ] Comps, codes and store grants all call grantAddOn (grep test)
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `features/licensing/{entitlements, add-ons}`; `features/managed-config/catalog` (flags leave); `help/library` (add-ons).
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen:transcripts -- --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set LX-35 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-35 done`.
