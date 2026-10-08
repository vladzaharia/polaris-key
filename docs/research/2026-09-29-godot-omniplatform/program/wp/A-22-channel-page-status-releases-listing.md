# A-22 The channel page (Status, Releases, Listing, Sales, Setup)

| Field       | Value                                                                                                                                                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | A: Distribution channels and store provisioning (DX consolidation H: Distribution channels, storefronts and commerce)                                                                                                                                          |
| Size        | 1.4–2 engineer-weeks                                                                                                                                                                                                                                           |
| Depends on  | [A-20](A-20-product-facts-channel-read-model.md), [A-28](A-28-one-store-app-binding-derived-identity.md)                                                                                                                                                       |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [A-21](A-21-console-ia-distribution-commerce-groups.md), [A-23](A-23-channel-setup-wizards-setup-runner.md), [A-24](A-24-publish-everywhere-verb-facade.md), [CM-23](CM-23-console-commerce-offers-purchases-sales.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                             |
| Plan mode   | no                                                                                                                                                                                                                                                             |
| Gates       | `console-csp-parity`                                                                                                                                                                                                                                           |
| Human input | none                                                                                                                                                                                                                                                           |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                      |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **DC-05** in [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce).

- UX rows absorbed (`uxRows` in `backlog-changes.json`): UX-57.
- UX rows that name this package: UX-08b (parked: devices on this version; revive with A-22's Releases tab if operators ask for per-version device counts).

## Goal

The channel page (Status, Releases, Listing, Sales, Setup), as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **DC-05** in [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/release-distribution.md`](../../../2026-10-07-dx-consolidation/audits/release-distribution.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §4.3, for **DC-05**.
- [`audits/release-distribution.md`](../../../2026-10-07-dx-consolidation/audits/release-distribution.md), for file and line evidence.

## Scope

**In:**

- One page per channel (absorbs UX-57) with tabs Status, Releases, Listing, Sales and Setup; Sales renders only when the storefront facet is set up, otherwise its wizard; the App Store and Commerce pages re-homed; Play, Microsoft Store and Steam reach the same tabs (StoreControls and connector cards moved off Outlet credentials); PS-06's panel becomes the Polaris Key Sales tab; store credential editors in Setup (from ST-12); a Storefront entry opens the same page on Sales.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track H (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **DC-05**; DX consolidation H: Distribution channels, storefronts and commerce.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Both facets on one page when both are on
- [ ] Each side shows what its own source provides when the other is off
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set A-22 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set A-22 done`.
