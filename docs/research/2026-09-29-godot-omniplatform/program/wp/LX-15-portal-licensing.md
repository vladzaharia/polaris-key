# LX-15 Portal licensing: duration line, add-ons and Automatic grant

| Field       | Value                                                                                                                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (phase B: the model, server-only)                                                                                                                |
| Size        | 0.5–0.7 engineer-weeks                                                                                                                                                                                      |
| Depends on  | [LX-09](LX-09-entitlement-resolver.md), [LX-10](LX-10-anchor-choice.md), [PX-W6](PX-W6-purchase-source.md), [LX-41](LX-41-durations-subscriptions-core-trials.md), [P0-36](P0-36-portal-on-copy-catalog.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [CM-11](CM-11-portal-billing.md), [CM-26](CM-26-portal-account-purchases-across.md), [PX-28](PX-28-license-page-v2.md)                                              |
| Role        | `pkey-implementer`                                                                                                                                                                                          |
| Plan mode   | no                                                                                                                                                                                                          |
| Gates       | portal e2e                                                                                                                                                                                                  |
| Human input | none                                                                                                                                                                                                        |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                   |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/PX-W17.md`](../plans/PX-W17.md):** use `identityEnabled` to decide whether to create licence-held grants.

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track E, Licensing model](../../../2026-10-07-dx-consolidation/tracks.md#e-licensing-model)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Portal duration line (Renews / Trial ends / Ends / Updates ended, keeps working / Ended), add-ons with source badges, 'Automatic grant' from the copy catalog (sentence case, ADMIN.md:898 and PORTAL.md:1264) for licences with origin oidc, which LX-38 writes for every access-policy path (sign-in, Discover self-mint, email-domain and claim rules); drop 'Apply to a licence'.

- Title: was "Portal licensing: what you own with sources, licence cards, Apply to a licence, downloads on the resolver; PORTAL.md amendment".
- Depends on: added LX-41 and P0-36.

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/LX-41.md`](../plans/LX-41.md) §13: the duration line reads the portal view's `term` and `subscription`.

## Goal

The portal shows what a person owns with sources, licence cards, "Apply to a licence", and downloads on the resolver; PORTAL.md is amended.

## Why

[S-19 §7.11](../../notes/S-19-licensing-model.md#711-console-portal-and-sdk-surface); PX-W6 reads `grants` after LX-09's switch ([S-19 §8](../../notes/S-19-licensing-model.md#8-interactions-with-other-plans-exactly-what-changes)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-19 owner decisions](../../notes/S-19-licensing-model.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-19 §7.11](../../notes/S-19-licensing-model.md#711-console-portal-and-sdk-surface), [S-19 §9](../../notes/S-19-licensing-model.md#9-phased-plan-and-work-packages) row LX-15.
- `docs/design/PORTAL.md` §1, §3.1, §5.3.

## Scope

**In:**

- Portal views; downloads through `resolveDeviceEntitlements`; PORTAL.md edits (status precedence adds `refunded` and `superseded`).

**Out** (and where it belongs instead):

- "Run this device on" (→ LX-21).

## Design notes

- Copy uses "licence" in prose, `license` in UI copy (rule 4).

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

- Tile first line: tier as a neutral pill with the key glyph and the device count as a pill ('3/4 devices'; amber with an alert glyph at the limit), platform glyphs at the end. Then fact lines: duration ('Updates until Sep 14, 2027 · then keeps the last version', 'Lifetime', 'Updates ended at 4.1.3'), source ('Automatic grant', 'Bought on the App Store', 'From Example Audio'), add-ons ('3 add-ons'). No 'In your account ·' prefix (terse copy). Waiting and floating states keep LX-26's words. The 2026-10-08 mockups win over the guide's older export. (portal-10)

## Steps

1. Views.
2. Downloads.
3. PORTAL.md.

## Acceptance criteria

- [ ] Library shows source badges (portal e2e).
- [ ] Downloads honour the effective set (test).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
```

## Hand-off

- None.

The role agent sets `--set LX-15 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-15 done`.
