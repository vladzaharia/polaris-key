# CM-05 Checkout fulfilment and reversal (absorbs CM-06)

| Field       | Value                                                                                                                                                                                                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | CM: Commerce: store commerce (required) and Polaris Key checkout (deferred)                                                                                                                                                                                                  |
| Size        | 1.2–1.6 engineer-weeks                                                                                                                                                                                                                                                       |
| Depends on  | [CM-04](CM-04-offers-catalogue.md), [PS-04](PS-04-storefront-portal-api.md), [LX-09](LX-09-entitlement-resolver.md), [LX-10](LX-10-anchor-choice.md), [LX-12](LX-12-licence-lifecycle.md), [LX-13](LX-13-entitlements-backend.md)                                            |
| Unblocks    | [CM-08](CM-08-subscriptions.md), [CM-10](CM-10-gifting.md), [CM-14](CM-14-device-checkout-wire.md), [CM-19](CM-19-own-account-mode.md)                                                                                                                                       |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                           |
| Plan mode   | no (executes its sections of the approved [`plans/CM-01.md`](../plans/CM-01.md))                                                                                                                                                                                             |
| Gates       | `migration`, `table-owners`, `rule-10`, `rule-6`, `threat-model`, `docs:privacy`, `portal-e2e`, `workerd`                                                                                                                                                                    |
| Human input | the owner's go signal (removes `deferred`); a Stripe platform account with Connect enabled, in a sandbox, and a test connected account, for live checks (fixtures and recorded responses otherwise); the G1 legal review and G4 waiver wording before the first live payment |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                    |

> **Deferred. Do not dispatch.** This package is optional and carries `deferred` in
> `workpackages.json`: the owner asked for the commerce plan on 2026-10-05 but not for its
> execution. `check.mjs --ready` does not list it. It becomes dispatchable only when the owner says
> go and the lead removes the `deferred` field.

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Absorbs CM-06: one fulfil-and-reverse state machine. Fulfilment mints through core/licensing/issue.ts; Stripe refunds and disputes call CM-22's revokePurchase; partialRevokes and disputes.onOpen settings dropped; its emails on P0-21.

- Title: was "Checkout and fulfilment for one-time purchases: checkout from a `buy` path, hosted Stripe Checkout (direct charge, Stripe Tax), fulfil-on-return and on-webhook through `issueFromPath`, grants with source `polaris-key`".
- Absorbs CM-06: One fulfil-and-reverse state machine.
- Absorbs CM-13: Emails ride with their events on P0-21: fulfilment, refund and ended in CM-05; renewal and dunning in CM-08.

## Goal

A signed-in person buys a one-time offer through hosted Stripe Checkout on the developer's account; the order is fulfilled exactly once whether the return page or the webhook arrives first, by calling S-21's single issuance function `issueFromPath(path, account)` with the `offer` path and the provider's verified result; a base offer mints a licence, an add-on an account-held grant, a seat pack a licence-held grant, all with source `polaris-key`, `external_ref_hash` and `order_ref`, and the holder version bump emits `entitlements.changed`.

## Why

This is the core of "charge directly from within" ([S-22 §7.3](../../notes/S-22-polaris-key-commerce.md#73-checkout-and-fulfilment-one-time-purchases), D3, D8, D9, D12).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode for wire-touching work).
- [S-22 owner decisions](../../notes/S-22-polaris-key-commerce.md) (the 2026-10-05 header block and §10; they win over the sections below them).
- [S-22 §7.3](../../notes/S-22-polaris-key-commerce.md#73-checkout-and-fulfilment-one-time-purchases)
- [S-22 §8](../../notes/S-22-polaris-key-commerce.md#8-threat-model-pci-scope-privacy-and-retention)
- [S-19 §7.2](../../notes/S-19-licensing-model.md#72-data-model), [§7.6](../../notes/S-19-licensing-model.md#76-lifecycle-terms-trials-subscriptions-refunds-dunning-upgrades-bundles)
- `plans/LX-01.md` §2.5, §6.1
- `plans/CM-01.md`

## Scope

**In:**

- `dist_orders`, `dist_order_lines`, `commerce_customers`.
- `POST /api/commerce/checkout` (re-evaluates the `buy` path through the engine first, like PS-04's claim), `POST /api/commerce/orders/<id>/fulfil`, the `/buy/…` focused-flow pages (minimal; CM-11 completes the UI).
- `fulfilOrder()` state machine that calls `issueFromPath` for each line. Because the engine and `issueFromPath` live in the identity service (S-21 Q5) and commerce lives in Distribution, `issueFromPath` is reached through a single-provider Core hook method (`issuance().issueFromPath`, provided by identity); CM-01 fixes the name and PS-04 is amended to expose it.
- The `offer` branch of `issueFromPath`: writes only through `core/grants.ts` and the licence writer, with `source = 'polaris-key'`, `external_ref_hash`, `order_ref`.
- Stripe Tax, tax codes, invoice creation per setting, waiver consent per setting.

**Out** (and where it belongs instead):

- Refunds (→ CM-06)
- Upgrades (→ CM-07)
- Subscriptions (→ CM-08)
- Device hand-off route (→ CM-14)

## Design notes

- The client sends an offer id, never an amount (CM-T4).
- Sign-in required; no guest checkout (D8).
- Success and cancel URLs are fixed portal paths (CM-T9).

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

1. Ledger tables.
2. Checkout route and Stripe session.
3. Fulfilment from both entry points.
4. Portal e2e with recorded Stripe responses.

## Acceptance criteria

- [ ] Return-then-webhook and webhook-then-return each fulfil once (tests).
- [ ] A base offer mints a licence with `source = polaris-key` and `external_ref_hash` (test).
- [ ] An event for another merchant's account is refused (test).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

## Hand-off

- CM-06 to CM-10 extend `fulfilOrder` and the order state machine.

The role agent sets `--set CM-05 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set CM-05 done`.
