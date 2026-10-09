# UK-62 Kit playground: a static React bundle built here

| Field       | Value                                                                  |
| ----------- | ---------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md)  |
| Size        | 0.6–1.2 engineer-weeks                                                 |
| Depends on  | [UK-47](UK-47-react-kit-and-gate-fixes-before-uk-05.md)                |
| Unblocks    | none                                                                   |
| Role        | `pkey-implementer`                                                     |
| Plan mode   | no (no wire change)                                                    |
| Gates       | ui-snapshots, modernity-lint                                           |
| Human input | The website owner swaps the plrs.im iframe src to the published bundle |
| Repo        | `vladzaharia/polaris-key`                                              |

## Goal

`examples/ui/react-playground` is a static bundle built from `@polaris-key/react` with a fixture client and no network, with surfaces sign-in, settings, updates and devices. plrs.im and the console's drop-in preview embed this artifact instead of the website's stale copy.

## Why

The website's embedded React kit demo is a stale copy. One playground built here cannot drift from the kit.

## Read first

- `AGENTS.md` and the relevant skill.
- [Brand transition decisions](../BRAND-TRANSITION.md), B11.
- The design docs the decisions amend: `docs/design/BRAND.md`, `docs/design/EXPERIENCE.md`, `docs/design/UI-KITS.md`, `docs/design/PORTAL.md` and `docs/design/ADMIN.md` as they apply.

## Scope

**In:**

- Controls: Preset (Product is the default, Native, Polaris Key), Appearance (System, Dark, Light), Accent (through the §3.3 resolver), Product name; constant-label toggles with `aria-pressed`; a 'Sample data' marker.
- Build output and its SHA-256 published as a release artifact.
- Every state is reachable: bad key, device limit, update available, update current.

**Out** (and where it belongs instead):

- The website's own page (→ website repo).

## Brand transition (2026-10-09)

New package from the brand and transition integration. Sources: Brand transition B11 (program/BRAND-TRANSITION.md); section change site-33. No wire change; do not derive APIs, entitlements or permissions from any mockup. Where the brand guide and a current mockup, design-language rule (DL1-DL18) or owner note disagree, the mockup, rule or note wins (B-decisions, source precedence).

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

- [ ] Runs under the site CSP (`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'self'`).
- [ ] axe reports zero violations at 390 and 1440 in both themes.
- [ ] DL4, DL5, DL7 and DL13 lint passes; the console's drop-in preview reuses the bundle.
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```
mise exec node@22 -- pnpm <the package's own tests>
```

## Hand-off

What downstream packages rely on from this one is listed in its Unblocks row. The role agent sets `--set UK-62 in-review` when it hands off; after review the lead adds the last commit `--set UK-62 done`.
