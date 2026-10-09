# F-38 Package feeds console: the cleanup dry-run dialog and the public-registry wizard

| Field       | Value                                                                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | F: Package feeds (pkg.plrs.im) (UX coverage (2026-10-09))                                                                                     |
| Size        | 0.8–1.2 engineer-weeks                                                                                                                        |
| Depends on  | [F-35](F-35-publish-public-registries-absorbs-dc-13.md), [F-36](F-36-feed-cleanup-on-default-dev-main.md), [ST-48](ST-48-console-shell-v2.md) |
| Unblocks    | none                                                                                                                                          |
| Role        | `pkey-implementer`                                                                                                                            |
| Plan mode   | no (no wire change)                                                                                                                           |
| Gates       | `console-csp-parity`, `ui-snapshots`                                                                                                          |
| Human input | none                                                                                                                                          |
| Repo        | vladzaharia/polaris-key                                                                                                                       |

## Goal

Console users can preview a feed cleanup (per-package table, CSV, notice callout) and set up publishing to a public registry (npm, PyPI, GHCR and the others F-35 supports) from the console.

## Why

F-36 is a Worker package and F-35 a CLI package; neither builds the console surfaces the two mockups draw.

## Read first

- AGENTS.md and the relevant skill.
- `program/ux-coverage.md` (the item list this package closes) and `program/ux-waves.md` (where it sits in the schedule).
- Brand transition decisions `program/BRAND-TRANSITION.md` (B-numbers) and the design docs the work touches.

## Scope

**In:**

- The cleanup dry-run dialog over F-36's dry-run (per-package table, CSV export, the notice callout, no destructive default).
- The public-registry wizard over F-35's publish commands: choose registry, credentials step (never shown after save), verify, done.

**Out** (and where it belongs instead):

- Worker retention logic (F-36) and the CLI publish (F-35).

## Screens and items this package closes

- `packages.cleanup-dry-run`
- `packages.public-registry`

## UX gate

New package from the UX coverage pass (2026-10-09). A built screen is done only when `pkey-ux-reviewer` passes it in BUILT mode and the pass is recorded: `node check.mjs --ux-review F-38 pass "<evidence>"`. No wire change; do not derive APIs, entitlements or permissions from any mockup.

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

- [ ] Both screens match their mockups in the real console.
- [ ] Credential fields are masked and never echoed after save.
- [ ] The green gate passes (AGENTS.md), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm <the package's own tests>
```

## Hand-off

What downstream packages rely on from this one is listed in its Unblocks row. The role agent sets `--set F-38 in-review` when it hands off; after review, and after the UX review is recorded, the lead adds the last commit `--set F-38 done`.
