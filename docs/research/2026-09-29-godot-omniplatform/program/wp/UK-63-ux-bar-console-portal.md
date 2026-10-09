# UK-63 UX bar for the built console and portal: B6, B7 and B17 lint over the rendered DOM, 400% reflow, forced-colors, contrast, 44 px and scroll-region rows, and the reviewer bar

| Field       | Value                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------ |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (UX coverage (2026-10-09)) |
| Size        | 1–1.5 engineer-weeks                                                                             |
| Depends on  | [ST-48](ST-48-console-shell-v2.md), [PX-26](PX-26-wide-zoomed-layouts.md)                        |
| Unblocks    | none                                                                                             |
| Role        | `pkey-implementer`                                                                               |
| Plan mode   | no (no wire change)                                                                              |
| Gates       | `modernity-lint`, `portal-e2e`, `console-csp-parity`                                             |
| Human input | none                                                                                             |
| Repo        | vladzaharia/polaris-key                                                                          |

## Goal

The rules that decide whether a built screen is right are checked by a test, not only by a reviewer: the console and portal are held to the same B6 (rejected patterns), B7 (weights) and B17 (service-accent state) rules as the kit boards.

## Why

UK-55's lint targets kit boards and kit sources. Nothing runs B6, B7 or B17 over the console or portal, the portal e2e checks 24 px not 44 px targets, and nothing tests 400% reflow, forced-colors, prefers-contrast or labelled scroll regions. The reviewer agent's bar lacks the same rows.

## Read first

- AGENTS.md and the relevant skill.
- `program/ux-coverage.md` (the item list this package closes) and `program/ux-waves.md` (where it sits in the schedule).
- Brand transition decisions `program/BRAND-TRANSITION.md` (B-numbers) and the design docs the work touches.

## Scope

**In:**

- packages/ui-qa rules run against the rendered console and portal DOM in e2e: accent-as-status, section-index, per-component focus colour, glow/gradient/coloured shadow, rim/hairline neutral, eyebrow repeating the breadcrumb, tagline, name-over-art, font-bold guard.
- e2e rows: 44 px targets on customer surfaces at the phone rows, 400% reflow at 320 CSS px, forced-colors, prefers-contrast: more, reduced transparency, dense tables only in a labelled focusable region, the 640x360 small-landscape row.
- The pkey-ux-reviewer agent bar gains the same rows (.claude/agents/pkey-ux-reviewer.md) with the lead's approval.
- A guard test that ux-reviews.json records a pass for every done package that owns a screen.

**Out** (and where it belongs instead):

- Kit-source lints (UK-55, optional): UK-63 builds its console/portal rules in packages/ui-qa and reuses UK-55's helpers if they exist.

## Screens and items this package closes

- no mockup screen; the items are listed in `ux-coverage.json` under this package id

## UX gate

New package from the UX coverage pass (2026-10-09). A built screen is done only when `pkey-ux-reviewer` passes it in BUILT mode and the pass is recorded: `node check.mjs --ux-review UK-63 pass "<evidence>"`. No wire change; do not derive APIs, entitlements or permissions from any mockup.

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

## Acceptance criteria

- [ ] The lint and e2e rows fail on a seeded violation of each rule and pass on the shipped screens.
- [ ] No debt ledger entry is added to get green.
- [ ] The green gate passes (AGENTS.md), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm <the package's own tests>
```

## Hand-off

What downstream packages rely on from this one is listed in its Unblocks row. The role agent sets `--set UK-63 in-review` when it hands off; after review, and after the UX review is recorded, the lead adds the last commit `--set UK-63 done`.
