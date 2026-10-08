# CM-23 Console commerce: Offers, Purchases and the Sales tab

| Field       | Value                                                                                                                                                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | CM: Commerce: store commerce (required) and Polaris Key checkout (deferred) (DX consolidation H: Distribution channels, storefronts and commerce)                                                                                                       |
| Size        | 1.4–2 engineer-weeks                                                                                                                                                                                                                                    |
| Depends on  | [CM-21](CM-21-storefront-connection-notifications.md), [CM-22](CM-22-purchases-ledger-one-revocation-path.md), [LX-11](LX-11-commerce-rework.md), [A-22](A-22-channel-page-status-releases-listing.md), [LX-35](LX-35-add-on-definitions-grantaddon.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [CM-12](CM-12-console-commerce.md)                                                                                                                                                                              |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                      |
| Plan mode   | no                                                                                                                                                                                                                                                      |
| Gates       | `console-csp-parity`                                                                                                                                                                                                                                    |
| Human input | none                                                                                                                                                                                                                                                    |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                               |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **CM-23** in [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce).

- Owner 2026-10-07/08: Commerce is a service (CM-29, `plans/CM-29.md`). Its code lives in `services/commerce/`, device routes move to `/<p>/commerce/*` in CM-29's release with the SDK path strings (no aliases), and the store hook URLs stay as Commerce's canonical routes. Reconcile this package with CM-29's approved plan before building.

- Clears its entries in `packages/admin/test/copy.debt.json` (ST-37's console copy ledger).

## Goal

Console commerce: Offers, Purchases and the Sales tab, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **CM-23** in [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§4.2, §4.4, §6); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/commerce.md`](../../../2026-10-07-dx-consolidation/audits/commerce.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §4.2, §4.4, §6, for **CM-23**.
- [`audits/commerce.md`](../../../2026-10-07-dx-consolidation/audits/commerce.md), for file and line evidence.

## Scope

**In:**

- The Commerce sidebar group; an Offers editor with SKU chips per storefront, import and suggest, create on App Store or Play, catalog validation and the 3.1.3(b) warning; price and territory availability per SKU: one base price converted with each store's tools (Apple price points, Play convertRegionPrices) under the typed confirmation (TYPED_OPS), with read-only copy cards and deep links for Steam and itch.io (no price API); no store prices on the storefront page; the Purchases view (subscriptions are listed on the licence by LX-41 and linked from here); the channel Sales tab with the storefront wizard; today's IAP dialogs moved; Distribution -> Commerce retired with redirects; absorbs LX-14's mapping editors; the Commerce card on Integration (Verified from the commerce bit of sdk_sightings).

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track H (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **CM-23**; DX consolidation H: Distribution channels, storefronts and commerce.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] An offer is defined once and sold on several storefronts
- [ ] A base price converts with Apple's and Play's tools under a typed confirmation; Steam and itch.io show copy cards
- [ ] The legacy Commerce page redirects
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set CM-23 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set CM-23 done`.
