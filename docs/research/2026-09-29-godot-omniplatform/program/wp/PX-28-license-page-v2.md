# PX-28 License page v2

| Field       | Value                                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | PX: Customer portal (docs/design/PORTAL.md)                                                                                                |
| Size        | 0.5–0.8 engineer-weeks                                                                                                                     |
| Depends on  | [LX-15](LX-15-portal-licensing.md), [LX-41](LX-41-durations-subscriptions-core-trials.md), [P2-13](P2-13-portal-channel-picker-sha-256.md) |
| Unblocks    | none                                                                                                                                       |
| Role        | `pkey-implementer`                                                                                                                         |
| Plan mode   | no (no wire change)                                                                                                                        |
| Gates       | portal-e2e, ui-snapshots                                                                                                                   |
| Human input | none                                                                                                                                       |
| Repo        | `vladzaharia/polaris-key`                                                                                                                  |

## Goal

The license page follows `portal.license` and `portal.license-lapsed`: a License card with the term timeline, one downloads table, a neutral devices meter, and the Updates ended state stated once.

## Why

The 2026-10-08 mockups and the owner's lapsed-page decision are the source; the guide's older export is not.

## Read first

- `AGENTS.md` and the relevant skill.
- [Brand transition decisions](../BRAND-TRANSITION.md), B12.
- The design docs the decisions amend: `docs/design/BRAND.md`, `docs/design/EXPERIENCE.md`, `docs/design/UI-KITS.md`, `docs/design/PORTAL.md` and `docs/design/ADMIN.md` as they apply.

## Scope

**In:**

- License card leads the side column: tier pill, term block with timeline (start, today, end, 'then keeps the last version'), facts, Included, Add-ons with source.
- Get it is one downloads table (Platform, SHA-256, Download) with this device's build tinted first, plus SHA256SUMS.
- Neutral segmented devices meter (a limit, not an error); healthy licenses show no status pill.
- Updates ended: warning pill beside the name; 'Download <last covered>' is the only solid button; neutral callout '<next> isn't in your license'; Renew only in the term block; no 'Not included' row; phones get Email me the download.

**Out** (and where it belongs instead):

- Account packages (→ F-33).

## Brand transition (2026-10-09)

New package from the brand and transition integration. Sources: Brand transition B12 (program/BRAND-TRANSITION.md); section change portal-07. No wire change; do not derive APIs, entitlements or permissions from any mockup. Where the brand guide and a current mockup, design-language rule (DL1-DL18) or owner note disagree, the mockup, rule or note wins (B-decisions, source precedence).

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

## Acceptance criteria

- [ ] e2e states: healthy, updates-ended, expired stop-license (danger), floating or waiting license.
- [ ] 1440, 1024, 768 and 390 in both themes; UX review in BUILT mode.
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```
mise exec node@22 -- pnpm <the package's own tests>
```

## Hand-off

What downstream packages rely on from this one is listed in its Unblocks row. The role agent sets `--set PX-28 in-review` when it hands off; after review the lead adds the last commit `--set PX-28 done`.
