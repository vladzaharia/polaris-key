# MO-13 Motion QA closeout: frame strips of every pattern in the real app (both themes, reduced), the 4× CPU frame budget in CI-optional e2e, the contributor docs page and the component inventory updated

| Field       | Value                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | MO: Motion system (notes/S-23) (wave 4: closeout)                                                                                                                                                                                                                                                                                                                                                             |
| Size        | 0.3–0.5 engineer-weeks                                                                                                                                                                                                                                                                                                                                                                                        |
| Depends on  | [MO-04](MO-04-console-navigation-motion.md), [MO-05](MO-05-portal-navigation-motion.md), [MO-06](MO-06-portal-device-activation-motion.md), [MO-07](MO-07-portal-library-motion.md), [MO-08](MO-08-console-overlay-controls-motion.md), [MO-09](MO-09-console-data-motion.md), [MO-10](MO-10-console-shell-motion.md), [MO-11](MO-11-console-moments-counters.md), [MO-12](MO-12-reduce-motion-preference.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                                                                                                                                                                                                                                                                                                                        |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                                                                                                                                            |
| Plan mode   | no                                                                                                                                                                                                                                                                                                                                                                                                            |
| Gates       | `test:e2e` (the strips and frame checks run behind an opt-in variable); `pnpm --filter @polaris-key/docs check:links`; `adminCspParity`                                                                                                                                                                                                                                                                       |
| Human input | none                                                                                                                                                                                                                                                                                                                                                                                                          |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                                                                                     |

## Follow-ups from the 2026-10-06 reviews

Checked against `main` at `148439c4f`. Each item names the package whose review raised it.

- **Commit real-app strips** ([MO-05](MO-05-portal-navigation-motion.md),
  [MO-07](MO-07-portal-library-motion.md), [MO-09](MO-09-console-data-motion.md)). Each recorded
  real-app strips with the S-23 `real-app.ts` method for its review and kept them in scratch.
  Committing real-app strips of every pattern is this package's (the `PK_MOTION_STRIPS` mode).
  Re-record them rather than reuse them, since the code has moved on.
- **`pk-vt-tabpanel` on the other route-tab pages** ([MO-04](MO-04-console-navigation-motion.md)). Only
  `LicenseRecord.tsx` (and `PageTabs`' own `TabPanel`) mark their panels. `TierRecord`,
  `UserRecord`, `PackageRecord`, `FeedPage` (`areas/feeds/`), `ListingPage` and `RolloutsPage` morph
  the indicator but swap the panel at once. Mark each visible panel `pk-vt-tabpanel`, or move the
  page onto `TabPanel`.
- **Clip the PageTabs indicator to a scrolled tab strip** ([MO-04](MO-04-console-navigation-motion.md)).
  The strip scrolls sideways (`pk-scroll overflow-x-auto` in `PageTabs.tsx`), but the
  `pk-vt-indicator` snapshot paints in the transition's top layer, so on a scrolled strip it can draw
  outside the strip's visible box. Clip it to the strip with a nested view-transition group where
  the browser supports one, and otherwise drop the morph while the strip is scrolled.
- **Prefetch the licence record on row hover and focus** ([MO-04](MO-04-console-navigation-motion.md)).
  The first drill-down into an uncached record shows its skeleton, so the name (`pk-key`) has no
  other end and leaves with the list; it flies only once the record is cached. Prefetch the
  record's query when a Licenses row is hovered or focused (as the sidebar prefetches section chunks
  on `onMouseEnter` and `onFocus`), so the first flight works too, and update the smoke suite's
  uncached case.
- **QA the 30-second polling tables** ([MO-09](MO-09-console-data-motion.md)).
  `console/pages/platformOperations.tsx` refetches every 30 s (`OPERATIONS_REFRESH_MS`). Check in
  the real app what each poll does: changed values tint (MO-09's changed-value cue) and moved rows
  reorder. Confirm an unchanged poll does nothing and a changed one still reads well every 30 s, in
  both themes and reduced, and record the result in the PR.
- **Enter-after-survivors for other lists** ([MO-09](MO-09-console-data-motion.md)). A table's
  entering rows now start after the survivors land (`.pk-vt-table`, MO-09's block in `motion.css`),
  because rows entering from below the fold crossed survivors that were still moving. Check the
  other lists whose items enter while others move, and apply the same timing where the crossing
  shows.

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track J, SDK and UI-kit consolidation](../../../2026-10-07-dx-consolidation/tracks.md#j-sdk-and-ui-kit-consolidation)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Trimmed: no committed real-app frame strips (they go stale on every UI change); TabPanel adoption moves into P0-39; keep the contributor page (including the kits' motion mapping) and the 30-second poll QA.

## Goal

The motion system is proven in the real app, not just the prototypes: every pattern has a strip, every moment meets the frame budget at 4× CPU, and contributors have one page that says how to add motion.

## Why

The prototypes tuned the rules (notes/S-23 §3.4–§3.5); the app has to show the same results, and the limits in §11 (one machine, no Firefox) should be re-checked where possible.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [notes/S-23-motion-system.md](../../notes/S-23-motion-system.md): the decisions D1–D10, §5 (tokens), §6 (patterns and rules), §10 (this package's row).
- The reference implementation: [`prototype/motion/motion.css`](../../prototype/motion/motion.css) and [`motion.js`](../../prototype/motion/motion.js); the flows in [`portal.html`](../../prototype/motion/portal.html) and [`console.html`](../../prototype/motion/console.html); the strips in [`shots/`](../../prototype/motion/shots/).
- [`prototype/motion/tools/`](../../prototype/motion/tools/) (`strips.mjs`, `perf.mjs`, `real-app.ts`).
- `packages/docs/src/content/docs/contribute/`, `docs/design/admin/components.md`.

## Scope

**In:**

- `PK_MOTION_STRIPS=<dir>` mode in `e2e/motion.e2e.test.ts` writing a strip per pattern (both themes, plus reduced) with the CDP playback-rate technique.
- A frame check per moment at 4× CPU throttling: p95 ≤ 33 ms (opt-in, not a CI blocker on shared runners).
- Firefox: run the smoke suite in Firefox where Playwright's Firefox launches (CI's Linux runner) and record the result.
- A contributor page "Adding motion" (tokens, patterns, the rules, how to test) under `packages/docs/src/content/docs/contribute/`, and `docs/design/admin/components.md` rows for `src/ui/motion`.

**Out** (and where it belongs instead):

- New motion.

## Design notes

- The docs site is gated (AGENTS.md rule 11); a new page needs its `check:links` pass and, if linked from the console, the `docsLinks` tables.

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

## Files it touches

`e2e/motion.e2e.test.ts`, a new docs page, `docs/design/admin/components.md`.

## Brand transition (2026-10-09)

Applied from the brand and transition integration ([Brand transition decisions](../BRAND-TRANSITION.md)). This section wins over the text below where they differ.

- Add frame strips and assertions: the canvas, rule and masthead never move on route change between siblings (only the body fades); the record masthead stays anchored across tab changes; the new-product shared element; the duration timeline marker; the active nav marker does not animate colour on hover beyond `micro`; every one instant under reduced motion. (admin-1-34, admin-2-30, brand-21, portal-24)
- When A-24, U-31, P2-09 and P2-11 have landed, add strips for publish result rows, the approve drawer changed-while-open notice, the promote or demote lane and channel cell update, and updater failure persistence; otherwise list them as follow-ups. (admin-1-34, admin-2-30, brand-21, portal-24)
- Add the guide's three checks: with `document.hidden` no animation frames run for the spinner, shimmer or refetch bar; hosted consent and sign-in controls are enabled and unanimated on first paint; the workspace entrance runs once per session entry and never on in-app navigation. (admin-1-34, admin-2-30, brand-21, portal-24)
- Portal: a frame strip of the Library tile to product hero shared-element transition at 1440 and 390 in both themes plus reduced motion as an instant swap; no download or primary action button changes position or size during any portal transition or art fade-in. (admin-1-34, admin-2-30, brand-21, portal-24)

## Steps

1. Strips mode.
2. Frame check.
3. Firefox run.
4. Docs.

## Acceptance criteria

- [ ] A strip exists for every pattern of notes/S-23 §6.1 in both themes and reduced, and the PR links them.
- [ ] Every moment meets p95 ≤ 33 ms at 4× CPU on the measuring machine (numbers in the PR).
- [ ] The docs page builds and `check:links` passes.
- [ ] The green gate passes (AGENTS.md), including `pnpm --filter @polaris-key/worker test adminCspParity` after the admin build and `pnpm --filter @polaris-key/admin test:e2e` with zero CSP violations.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin build
PK_MOTION_STRIPS=/tmp/strips mise exec node@22 -- pnpm --filter @polaris-key/admin test:e2e
mise exec node@22 -- pnpm --filter @polaris-key/docs build && mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
```

## Hand-off

Marked done last; the phase is complete when it is. The role agent sets `--set MO-13 in-review` when it hands off. After review, the lead adds the last commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set MO-13 done`.
