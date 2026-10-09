# CM-12 Polaris Key Sales tab content

| Field       | Value                                                                                                                                                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | CM: Commerce: store commerce (required) and Polaris Key checkout (deferred)                                                                                                                                           |
| Size        | 1.2–1.6 engineer-weeks                                                                                                                                                                                                |
| Depends on  | [CM-08](CM-08-subscriptions.md), [LX-14](LX-14-console-licensing.md), [PS-06](PS-06-console-polaris-key-storefront.md), [CM-23](CM-23-console-commerce-offers-purchases-sales.md), [CM-04](CM-04-offers-catalogue.md) |
| Unblocks    | [CM-17](CM-17-commerce-closeout.md)                                                                                                                                                                                   |
| Role        | `pkey-implementer`                                                                                                                                                                                                    |
| Plan mode   | no (executes its sections of the approved [`plans/CM-01.md`](../plans/CM-01.md))                                                                                                                                      |
| Gates       | `ui-snapshots`, `console-csp-parity`, `docs-links`, `rule-10`                                                                                                                                                         |
| Human input | the owner's go signal (removes `deferred`)                                                                                                                                                                            |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                             |

> **Deferred. Do not dispatch.** This package is optional and carries `deferred` in
> `workpackages.json`: the owner asked for the commerce plan on 2026-10-05 but not for its
> execution. `check.mjs --ready` does not list it. It becomes dispatchable only when the owner says
> go and the lead removes the `deferred` field.

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> The Polaris Key channel page's Sales tab content (A-22, CM-23): merchant status, prices, Stripe refund and re-fulfil, revenue and webhook health; not a separate Commerce area.

- Title: was "Console commerce: Product → Commerce (merchant, offers, orders with refund and re-fulfil, subscriptions, coupons, revenue, settings); platform merchants and webhook health".
- Depends on: added CM-23 and CM-04; removed CM-07 and CM-09.

## Goal

Developers manage commerce from the console: connect a merchant, edit offers and prices, search orders and refund or re-fulfil them, manage subscriptions and coupons, read revenue per currency from the ledger, and edit the `commerce.*` settings; platform admins see merchants and webhook health.

## Why

"The console (products' pricing, revenue, refunds)" from the brief ([S-22 §7.11](../../notes/S-22-polaris-key-commerce.md#711-console-and-emails), D29).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode for wire-touching work).
- [S-22 owner decisions](../../notes/S-22-polaris-key-commerce.md) (the 2026-10-05 header block and §10; they win over the sections below them).
- [S-22 §7.11](../../notes/S-22-polaris-key-commerce.md#711-console-and-emails)
- [S-22 §7.13](../../notes/S-22-polaris-key-commerce.md#713-settings-s-18-registry)
- `docs/design/ADMIN.md`
- `plans/CM-01.md`

## Scope

**In:**

- ADMIN.md amendment.
- Commerce area pages; 3.1.3(b) parity warning for offers without an iOS IAP mapping.
- PS-06's Polaris Key panel gains the `offer` path kind in "Ways to add", prices in the persona preview, and revenue columns on its analytics card (S-21 §6.10 seam 9).
- Platform merchants and webhook-health view.

**Out** (and where it belongs instead):

- Store revenue import (not in v1)

## Design notes

- Refund is L2 with a reason; merchant change is L3 (CM-03).

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

## Steps

1. ADMIN.md amendment.
2. Pages.
3. Snapshots in both themes.

## Acceptance criteria

- [ ] Refund from the console revokes the grant (e2e against the worker test harness).
- [ ] Revenue totals match the ledger (test).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
mise exec node@22 -- pnpm --filter @polaris-key/worker test adminCspParity
```

## Hand-off

- CM-17 documents the console pages.

The role agent sets `--set CM-12 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set CM-12 done`.
