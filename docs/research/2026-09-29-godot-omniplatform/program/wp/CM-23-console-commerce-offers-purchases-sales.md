# CM-23 Console commerce: Offers, Purchases and the Sales tab

| Field       | Value                                                                                                                                                                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | CM: Commerce: store commerce (required) and Polaris Key checkout (deferred) (DX consolidation H: Distribution channels, storefronts and commerce)                                                                                                                                           |
| Size        | 1.4–2 engineer-weeks                                                                                                                                                                                                                                                                        |
| Depends on  | [CM-21](CM-21-storefront-connection-notifications.md), [CM-22](CM-22-purchases-ledger-one-revocation-path.md), [LX-11](LX-11-commerce-rework.md), [A-22](A-22-channel-page-status-releases-listing.md), [LX-35](LX-35-add-on-definitions-grantaddon.md), [CM-29](CM-29-commerce-service.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [CM-12](CM-12-console-commerce.md)                                                                                                                                                                                                                  |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                          |
| Plan mode   | no                                                                                                                                                                                                                                                                                          |
| Gates       | `console-csp-parity`                                                                                                                                                                                                                                                                        |
| Human input | none                                                                                                                                                                                                                                                                                        |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                   |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **CM-23** in [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce).

- Owner 2026-10-07/08: Commerce is a service (CM-29, `plans/CM-29.md`). Its code lives in `services/commerce/`, device routes move to `/<p>/commerce/*` in CM-29's release with the SDK path strings (no aliases), and the store hook URLs stay as Commerce's canonical routes. Reconcile this package with CM-29's approved plan before building.

- Clears its entries in `packages/admin/test/copy.debt.json` (ST-37's console copy ledger).

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/CM-20.md`](../plans/CM-20.md) §14: its console lives in CM-29's Commerce section, which shows while the service is on. Its release removes the legacy `PUT|DELETE …/commerce/products` route, with no alias (§6.4).
- [`plans/CM-29.md`](../plans/CM-29.md) §10: its code goes in `services/commerce/`, after CM-29.

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

## Screen acceptance (brand transition, 2026-10-09)

Done when every row holds for each screen and state this package ships, checked in the real runtime
(not mockups; native kits on device or simulator), with evidence paths in the PR. A row that cannot
apply says why in one line. One home: EXPERIENCE.md §7.3; kits also follow DL1–DL18.

- [ ] Keyboard: tab order follows reading order; focus always visible (DL9); no trap outside a modal;
      Escape or Cancel backs out of every overlay and step; focus returns to the opener (or the heading
      when it is gone); a route change changes the URL and moves focus to the h1, an inline mutation
      changes neither.
- [ ] Screen readers: landmarks and exactly one h1; every icon-only control named; help and errors
      linked (aria-describedby); one polite announcement per change, none while typing; tables use
      th with scope; status is a word and an icon, never colour alone.
- [ ] Sizing: this surface's UI-KITS §7.1 rows plus 200 % text and 400 % zoom (320 CSS px reflow) with
      no page-level sideways scroll; a dense table scrolls only inside a labelled, focusable region;
      targets ≥ 44 px on customer and touch surfaces, ≥ 24 px with separation in the console.
- [ ] Themes: dark and light; a custom product accent on a light and a dark ground (kits, hosted
      sign-in); forced-colors; prefers-contrast: more; reduced transparency; contrast measured on the render (text 4.5:1, UI 3:1) for every state colour in its service accent, both themes.
- [ ] States: loading (skeleton after the grace), first-run empty, filtered empty, permission refused,
      expired or stale, network and API error with Try again, partial failure, success; input survives a
      failed save; where the API sends expectedVersion, a changed-since-open conflict is named with
      Reload.
- [ ] Motion: tokens only; reduced motion is an instant swap and the outcome still reads; errors appear
      without moving content; progress is real (no invented percentage, nothing loops after a failure);
      no celebration on refunds, revocation, removal, deletion or consent.
- [ ] Hierarchy and copy: one filled primary per state (neutral action ink in console, portal and hosted
      sign-in; the product accent in kits); focus, selected, hover, checked and context
      borders take the accent of the service the element references (data-service; -fg for
      text and edges, base for fills; a non-colour cue stays); status colours (success,
      warning, danger, info, signed) never become a service accent; copy from the catalog, each fact once; no decorative numbers or
      taglines; no text drawn over customer art.
- [ ] Native (kits): Dynamic Type or font scale at the 200 % row, VoiceOver or TalkBack, gamepad and
      D-pad focus, TV and title-safe insets, terminal keys with NO_COLOR, ascii and --json paths.
- [ ] pkey-ux-reviewer passes the built screens (BUILT mode).

## Brand transition (2026-10-09)

Applied from the brand and transition integration ([Brand transition decisions](../BRAND-TRANSITION.md)). This section wins over the text below where they differ.

- Build to `dx-mockups` commerce.\* at HEAD (after the multi-review), not the guide's 2026-10-08 01:01 export: Storefronts 'Selling' merged into State, Offers one attention card, offer editor two-column with Stop selling as a danger link at the page end, Purchases State pill only, purchase drawer without a restating callout. Chrome comes from ST-48. Commerce uses the Distribution green family everywhere (B1; no violet, no 'undefined' eyebrow); per-store outcomes update in place; every state has a mockup. (admin-3-17)
- [ ] `pkey-ux-reviewer` passes per screen in BUILT mode. (admin-3-17)

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] An offer is defined once and sold on several storefronts
- [ ] A base price converts with Apple's and Play's tools under a typed confirmation; Steam and itch.io show copy cards
- [ ] The legacy Commerce page redirects
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `features/commerce/*` (with `features/ship-builds/commerce` and `channels/storefronts` moved in); `help/restore-purchase`, `help/refunds`.
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set CM-23 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set CM-23 done`.
