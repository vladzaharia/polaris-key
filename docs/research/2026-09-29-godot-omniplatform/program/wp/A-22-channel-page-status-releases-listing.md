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

- Clears its entries in `packages/admin/test/copy.debt.json` (ST-37's console copy ledger).

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

- Route tabs (B4) are an underline tablist with roving focus. When the set overflows it scrolls horizontally with an edge fade in the surface colour (not black) and the selected tab scrolled into view; at 480 px and below with five or more tabs keep scrolling (no menu). Counts inside tabs use tabular numerals. This replaces the guide's segmented tabs, which B4 rejects. (admin-3-10)
- [ ] Mockups re-shot at 390 and 1024. (admin-3-10)
- Structure follows the current dx-mockups ids (I-29: identity.app-sign-in, identity.app-sign-in-changes, identity.sign-in-off; I-31: identity.connections, identity.connection*, centred 960 px wizard column; ST-38: commerce.features*, commerce.turn-off-licensing; A-22: commerce.sales\*; ST-39: the stepper where done steps say what was decided, inside the centred wizard column). The guide boards supply chrome only. (admin-3-18)
- [ ] `pkey-ux-reviewer` passes against those mockups in BUILT mode. (admin-3-18)

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 4 mockup item(s):** `distribution.channel-app-store`, `commerce.sales-wizard`, `commerce.sales`, `commerce.storefronts`.

## Acceptance criteria

- [ ] Both facets on one page when both are on
- [ ] Each side shows what its own source provides when the other is off
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `features/ship-builds/channels/*`, rewritten in place (one page per channel; the matrix section at A-21); `reference/channels`.
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set A-22 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set A-22 done`.
