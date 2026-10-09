# LX-43 Licensing presets, the 1.x helper, the new-major callout and the Integration Licensing card

| Field       | Value                                                                                                                                                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (DX consolidation E: Licensing model)                                                                                                                      |
| Size        | 0.8–1.1 engineer-weeks                                                                                                                                                                                                |
| Depends on  | [LX-41](LX-41-durations-subscriptions-core-trials.md), [LX-44](LX-44-license-console-v2-tiers-entitlements.md), [ST-41](ST-41-integration-page-overview-card.md), [LX-41b](LX-41b-console-durations-subscriptions.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                                                                                                                                |
| Role        | `pkey-implementer`                                                                                                                                                                                                    |
| Plan mode   | no                                                                                                                                                                                                                    |
| Gates       | `console-csp-parity`                                                                                                                                                                                                  |
| Human input | none                                                                                                                                                                                                                  |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                             |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **LX-43** in [Track E, Licensing model](../../../2026-10-07-dx-consolidation/tracks.md#e-licensing-model).

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/LX-41.md`](../plans/LX-41.md) §13: presets write `onExpiry`; "Trial then paid" creates a trial tier with `tier:<paid or free>`, through LX-41b's "When it ends" control.

## Goal

Licensing presets, the 1.x helper, the new-major callout and the Integration Licensing card, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **LX-43** in [Track E, Licensing model](../../../2026-10-07-dx-consolidation/tracks.md#e-licensing-model). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.2); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/entitlements-subscriptions.md`](../../../2026-10-07-dx-consolidation/audits/entitlements-subscriptions.md), [`audits/licensing-core.md`](../../../2026-10-07-dx-consolidation/audits/licensing-core.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track E, Licensing model](../../../2026-10-07-dx-consolidation/tracks.md#e-licensing-model): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.2, for **LX-43**.
- [`audits/entitlements-subscriptions.md`](../../../2026-10-07-dx-consolidation/audits/entitlements-subscriptions.md), for file and line evidence.
- [`audits/licensing-core.md`](../../../2026-10-07-dx-consolidation/audits/licensing-core.md), for file and line evidence.

## Scope

**In:**

- 'Choose how you sell it' presets (free, trial, lifetime, fixed duration, version-scoped, subscription, subscription that keeps the last version); the 1.x major-line helper in console and manifest; a 'first release of a new major' callout through the releaseCatalog hook with Start a 2.x tier...; per-model code samples from SP-33a's renderUsage('licensing') with the product's real keys; the Licensing card (Verified from the license bit of sdk_sightings); docs pages for durations, trials, add-ons and fallback.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track E (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **LX-43**; DX consolidation E: Licensing model.
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
      sign-in); forced-colors; prefers-contrast: more; reduced transparency; contrast measured on the
      render (text 4.5:1, UI 3:1).
- [ ] States: loading (skeleton after the grace), first-run empty, filtered empty, permission refused,
      expired or stale, network and API error with Try again, partial failure, success; input survives a
      failed save; where the API sends expectedVersion, a changed-since-open conflict is named with
      Reload.
- [ ] Motion: tokens only; reduced motion is an instant swap and the outcome still reads; errors appear
      without moving content; progress is real (no invented percentage, nothing loops after a failure);
      no celebration on refunds, revocation, removal, deletion or consent.
- [ ] Hierarchy and copy: one filled primary per state; the section accent marks context only, never
      success, warning or failure; copy from the catalog, each fact once; no decorative numbers or
      taglines; no text drawn over customer art.
- [ ] Native (kits): Dynamic Type or font scale at the 200 % row, VoiceOver or TalkBack, gamepad and
      D-pad focus, TV and title-safe insets, terminal keys with NO_COLOR, ascii and --json paths.
- [ ] pkey-ux-reviewer passes the built screens (BUILT mode).

## Brand transition (2026-10-09)

Applied from the brand and transition integration ([Brand transition decisions](../BRAND-TRANSITION.md)). This section wins over the text below where they differ.

- On a duration preset change the timeline markers translate to their new positions (`moderate` 260 ms, transform only), labels swap instantly, dates stay still, nothing loops; instant under reduced motion. Consumable balances animate (MO-11 CountUp) only when the server returns a new balance, never on filter changes. The 'What a <tier> license does' column keeps a head label and sits at 40% width or more on desktop. (admin-1-29)

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Each preset yields a valid tier and term with no further settings
- [ ] The Licensing card renders on ST-41
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `features/licensing/durations`; `help/subscriptions`, `help/license-status`.
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set LX-43 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-43 done`.
