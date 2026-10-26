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

## Progress and continuation (2026-10-11)

- Set MO-13 `in-progress` (`8551f9a2c`).
- Marked route-tab content with `pk-vt-tabpanel`: user, tier, profile, package,
  feed, listing, Rollouts, release, and pack pages (`aaf822ae6`, `539fe88b4`,
  `8587433b1`). This is the small route-panel marker alternative from the 2026-10-06
  follow-up, not the full `TabPanel` migration deferred by P0-39. P0-39's own
  correction says that migration remains undone.
- Prerequisite status checked: A-24, U-31, P2-09, P2-11, ST-43, ST-48, and LX-43
  are `todo`. Their publish/approve/promote/updater surfaces, new-product shared
  element, shell-v2 canvas/rule/masthead and workspace entrance, and duration marker
  therefore cannot yet have real-app strips. Add those strips once their owning
  packages land.
- Firefox is installed locally but Playwright Firefox 1543 exits before launch on
  macOS with `Could not find profile folder`; an explicit `/tmp` profile produced the
  same result. The Firefox smoke remains to run on a runner where Playwright launches.
- Next, in order: add the overflow-safe PageTabs indicator behavior and license
  prefetch; finish the 30-second Operations polling QA and remaining-list audit; add
  `PK_MOTION_STRIPS` plus opt-in 4× frame measurements and real-app assertions; add
  the contributor page and component inventory rows; run the listed verification.

## Progress and continuation (2026-10-16)

Reconciled against main in the 2026-10-16 audit. Remaining:

- Overflow-safe PageTabs indicator and licence prefetch
- 30-second Operations polling QA and remaining-list audit
- PK_MOTION_STRIPS plus opt-in 4x frame measurements and real-app assertions
- Contributor page and component inventory rows
- Real-app strips for surfaces blocked on todo packages A-24, U-31, P2-09, P2-11, ST-43, ST-48, LX-43
- Firefox smoke on a runner where Playwright launches
- Full TabPanel migration remains with P0-39

## Corrections (2026-10-23)

Checked against staging at 8a8548da2. The code is the fact; these override the text above.

- **B1. The consolidation trims stand.** No real-app strips are committed. TabPanel adoption moved to P0-39, which is done and left it to the packages that rebuild records (P0-39 brief:114), so it is out of MO-13.
- **B2. The PageTabs indicator clip is done.** B-026 (20b8febfc) drops the `pk-vt-indicator` name while the strip overflows (`motion.css:738`, `[data-strip-overflow]`, set at `PageTabs.tsx:201`). That is the brief's fallback.
- **B3. `pk-vt-tabpanel` is done** on the route-tab pages (2026-10-11, aaf822ae6 and after).
- **B4. The licence prefetch was open; MO-13.1 closes it.** The record reads `licenseQuery(slug, id)`; the row's primary cell is a real link from `rowHref`. `DataTable` gains `onRowIntent(row)` (pointer enter and focus of that link only, so a sweep down a 60-row table is not 60 reads); `LicensesPage` prefetches the record; `licenseQuery` carries an explicit `staleTime` so repeated hovers do not refetch.
- **B5. `console/pages/platformOperations.tsx` is gone.** ST-09 merged it into Platform → Status (`sections/platform/pages/platformStatus.tsx:38-55`). Auto-refresh is on by default with an operator pause (`AUTO_REFRESH_KEY`); the page polls every `OPERATIONS_REFRESH_MS = 30_000` (`platformOperationsAssess.tsx:33`) through `reads.platformOperations()` (P0-32). It does not use `ui/motion/changed.ts`.
- **B6. Strips already exist under `PK_SHOTS_DIR`** in `dataMotion`, `deviceMotion`, `libraryMotion` and `shellMotion`; the CDP playback-rate loop is copied three times; `motion.e2e.test.ts` has none. Reuse `PK_SHOTS_DIR` with one helper; no `PK_MOTION_STRIPS` (M1).
- **B7. No e2e throttles the CPU.** The method is `prototype/motion/tools/perf.mjs`. At 4x, S-23 §3.5 measured the 60- and 200-row filters at p95 33.3 and 33.4 ms, so the budget is p95 <= 33.4 ms (M2).
- **B8. Firefox.** Every admin e2e suite calls `chromium.launch()`; `layout.e2e.test.ts` has a `PK_LAYOUT_BROWSER` switch. The CI `console` job runs in `mcr.microsoft.com/playwright:v1.63.0-noble`, which ships Firefox. Locally Firefox exits at launch on macOS 27 (S-23 §11).
- **B9. Prerequisites have moved.** U-31, ST-43 and ST-48 are done. A-24, P2-09, P2-11 and LX-43 are still todo. Testable now: the masthead, the canvas, U-31's "The recipe changed while you were reviewing" notice. Not built anywhere: the workspace entrance and a new-product shared element (follow-ups, M6).
- **B10. Hidden tabs.** Nothing pauses loops on `visibilitychange` (BRAND.md:686). The spinner, shimmer and refetch bar are CSS-only (`motion.css:116-128`); the check is that no JS loop (rAF or timer) drives them.
- **B11. Docs.** `contribute/` has no motion page and its sidebar is an explicit list (`packages/docs/src/lib/doors.ts`). `docs/design/admin/components.md` has no `src/ui/motion` rows. The kits' motion mapping already lives in UI-KITS.md §4.8; link to it.
- **B12. Naming.** End users see the portal as Polaris Locker. The contributor page is Polaris Key developer docs and says "the portal (Polaris Locker)" once.

## QA record

### MO-13.2 console strips

- Helper: `packages/admin/e2e/strips.ts` (`frameStrip(page, name, act, options)`); `PK_SHOTS_DIR` unchanged. Files are `<name>-<dark|light|reduced>-<n>.png`, six frames at 30, 600, 1200, 1800, 2600 and 3600 ms at ×0.1, one frame under reduced motion.
- Evidence (not committed): `/Users/vlad/Repos/pk-wt/_evidence/MO-13/strips/`.
- Console strips (`console-<name>`): dialog-enter, dialog-exit, popover-enter, popover-exit, skeleton, morph-route, morph-forward, morph-tab, morph-back, shared-key, status-pill, press, expand (the sidebar section), success (the first release), changed-notice (U-31). Plus the existing `console-data-*`, `mo06-*` and `mo07-*` strips, now through the helper.
- Always-on assertions (motion.e2e, dark, light, reduced): sibling route keeps the canvas, masthead origin and width and the section rule; record masthead keeps its box across a tab change; the sidebar's active marker has no colour transition above `micro`; the approve drawer's notice leaves the drawer and its title where they are.
- Not in the console: inline-confirm expand (portal only, MO-13.3's strips).
- Observation for MO-13.5: the status-pill strip (a licence record going Waiting to Disabled) is identical from frame 1 to 6, so the changed-word pop is not visible in it.

### MO-13.3 portal strips and the guide's three checks

- Evidence (not committed): `/Users/vlad/Repos/pk-wt/_evidence/MO-13/strips/`.
- Strips: `mo13-tile-hero-<1440x900|390x844>-<dark|light|reduced>-<n>.png` (libraryMotion, Nightfall's tile into the product hero), and `mo06-expand-<dark|light|reduced>-<n>.png` (deviceMotion, the portal's inline-confirm expand; the console has none).
- Stable buttons (libraryMotion, both sizes, dark, light, reduced): the product page's "Download for" and "More for" buttons sampled every frame through Library to product to Library and the art fade-in; each keeps one box. The Library's own tile buttons are left out on purpose: the tile lifts 2 px under the pointer (MO-07).
- First paint (portalPassport, `app-signin` and `app-consent`, dark and light, motion on): every control is enabled and nothing around it animates, bar the focus ring easing in on the autofocused field, the step slide (`pk-step-*`) and AuthCard's height ease.
- Hidden tab (shellMotion): the second page's `bringToFront()` makes the first report `visibilityState === "hidden"` in headless Chromium; during the Platform skeleton's shimmer, app code makes 0 rAF calls. Not N/A.
- Workspace entrance: N/A, not built (B9).
- Observation for the follow-up list: on the 390 px product page the "Download my data" button moves 294 px while the page loads (a lower card settles); on 1440 the SHA-256 buttons widen 0.5 px and the "Remove my data" and "Get a support code" buttons shift 10 and 24 px. None is a download or primary button; owner: MO-13.5's list audit.

### MO-13.5 the 30-second poll and the list audit

- Case file: `packages/admin/e2e/pollMotion.e2e.test.ts` (11 cases; 14 with `PK_SHOTS_DIR`). Strips (not committed, `/Users/vlad/Repos/pk-wt/_evidence/MO-13/strips/`): `poll-unchanged-*`, `poll-changed-*`, `members-filter-*`, `members-clear-*`, `library-grid-to-list-*` (dark, light, one frame reduced). Run with load average well above 4 (about 60 on this machine), so the numbers below are timings read from the CSS, not frame times.
- Correction to the brief: `platformOperations.tsx` is gone (ST-09). The poll is Platform → Status (`platformStatus.tsx`), `refetchInterval` 30 s through `OPERATIONS_REFRESH_MS`; the case drives it with `page.clock.fastForward(30_000)`.
- **Unchanged poll** (only `generatedAt` moves): no animation, no transition, no View Transition, no tint, no row moves. Dark, light, reduced.
- **Changed poll** (queue 4 to 9 waiting, dead letters 0 to 3, a connector poll failing): no View Transition and no tint on any theme (`highlight()` is DataTable-only; this page has none). The page reads as an instant swap with one cue: a status pill whose word changes pops once (`pk-pop-in`, `slow`) and eases its colours (`base`): Scheduled jobs and Update delivery, OK to Degraded. A pill that appears (Failed, Waiting) just appears. Nothing reorders: rows are keyed and stay in order. What moves is everything below an inserted line: a new Checks row (Dead-letter queue) pushes Health by area, Scheduled jobs and the Deploys table down 61 to 69 px at once, and the queue card grows. Reduced motion: no animation at all, the same end state. Judgement for the UX review: the pop reads, the 61 to 69 px jump below the Checks table does not ease. A follow-up could name the Checks table and the cards in a `list` transition on a changed poll; this slice adds no motion.
- **The status-pill strip (MO-13.2) is a real gap, not a capture problem.** The pop runs: a floating licence's Active to Disabled pops "Disabled" once. The strip's record is Waiting: `HeaderStatus` returns a bare `StatusPill` while the licence is waiting and `LicenseStatus` otherwise, so React remounts the pill when the licence leaves Waiting and the new word never pops (`useChangedSinceMount` starts over). The case pins both. Follow-up (owner: the record rebuilders, P0-39): render one component for both, e.g. pass the Waiting tone and label into `LicenseStatus`.
- The changed-notice strip (U-31) shows no motion by design (MO-13.2).

List audit, from the `::view-transition-*` animations of one transition (entering item = `pk-enter` new picture; moving survivor = a group animation whose box or transform changes; the `pk-main` region left out):

| List                                            | Entering vs survivors                                                                               | Verdict                                                                                                                                                                                                                |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Licenses table (holder chips and facet filters) | rows enter at 280+120 after survivors land at 280 (MO-09, dataMotion)                               | no crossing, already `.pk-vt-table`                                                                                                                                                                                    |
| Platform → Members, Clear filters               | 11 rows enter at 280+120, survivors end at 280                                                      | no crossing, already `.pk-vt-table` (asserted)                                                                                                                                                                         |
| Platform → Members, a Role filter               | no rows enter; the filter-chip row enters at 120+200 while the table makes room (survivors end 280) | crossing by the numbers on the chip row, not in the strips: it fades into the gap the table opens. No change. Not a table row, so `.pk-vt-table` would not apply, and delaying it would leave an empty band for 280 ms |
| Filter chips (FilterBar)                        | a chip pops in, a removed one fades in place and then leaves (MO-09)                                | no survivor moves while one enters                                                                                                                                                                                     |
| Settings → Members (`SettingsMembers`)          | a plain table, no list transition                                                                   | nothing to cross                                                                                                                                                                                                       |
| Library Grid/List                               | the new view rises at 120+200 while the section box and the page footer finish gliding (280)        | crossing by the numbers, none in the strips (they glide into the space the view rises in). No change; pinned in the case                                                                                               |
| Portal Devices card                             | list is `.pk-vt-table` (asserted); remove leaves, nothing enters                                    | no crossing                                                                                                                                                                                                            |

- No `motion.css` change, so `motionLint` was not rerun.
- Product-page controls that move while it loads (MO-13.3's observation): not a list, and no new motion belongs in this slice. Recommendation for a follow-up (owner: a portal layout package): `ProductDataCard` draws its two descriptions from `useProduct(slug).data?.services`, so they reflow when the product query lands, which shifts "Remove my data" and "Get a support code" 10 and 24 px at 1440; give the card the same copy until the services arrive, or hold its description height. The 294 px move of "Download my data" at 390 is the card sitting under content that settles (reserve the lower cards' height with the skeleton). The 0.5 px widening of the SHA-256 buttons looks like a scrollbar gutter change when the page grows (`scrollbar-gutter: stable` on the scroller); that cause is a guess, not measured. Buttons in the Downloads table were stable in MO-13.3.
- For the BUILT UX review (pkey-ux-reviewer, both themes and reduced): console `#/platform/status` (wait 30 s, or open the strips `poll-*`), `#/platform/members` (Role filter then Clear filters), `#/p/djdl/license/licenses/<a floating licence>` (status pill pop), the Licenses table filter and Clear, the portal Library Grid to List, a product's Devices card remove, plus the strips from MO-13.2, MO-13.3 and MO-13.1's first flight.

### MO-13.6 the Firefox motion smoke

- `motion.e2e.test.ts` honours `PK_MOTION_BROWSER=firefox|webkit` (as `PK_LAYOUT_BROWSER` does in `layout.e2e.test.ts`); Chromium stays the default. `frameStrip` (CDP `Animation.setPlaybackRate`) returns outside Chromium. The three View Transition helpers (`runViewTransition`, `armNavigation`, `watchTransitions`) skip the running test, with the reason, where `document.startViewTransition` is missing (S-23 §6.3 fallback).
- CI: the `console` job has one step, "Motion smoke (Firefox)", `continue-on-error: true` until it has passed once on main; then remove `continue-on-error`.
- Local: Chromium 52 passed, 9 skipped (unchanged); `PK_MOTION_BROWSER=firefox` reaches `firefox.launch()` and fails there with "Could not find profile folder" (B8), so the switch is wired.
- **CI result: pending** (first run: the v0.9.18 push). S-23 §11 reads "measured in CI on <first run>; pending" until the lead fills it.

### MO-13.4 the 4x CPU frame check

- Case file: `packages/admin/e2e/motionPerf.e2e.test.ts`, under `describe.skipIf(!process.env.PK_MOTION_PERF)` (skipped without the switch). It runs the nine moments in the built apps under the Worker's CSP at 1280 x 800, dark, motion on. CDP `Emulation.setCPUThrottlingRate { rate: 4 }`; rAF timestamps from the document's start; the action moments take the frames from just before the action for 700 ms, the loads (portal Library, console Overview) the first 1.5 s of the new document. p50, p95 (nearest rank) and max are printed as a table; `$PK_SHOTS_DIR/perf.json` is written when that is set. Assertion: p95 <= 33.4 ms (M2). The budget was not raised.
- Run: `PK_MOTION_PERF=1 PK_SHOTS_DIR=<dir> heavy.sh ... vitest run -c vitest.e2e.config.ts e2e/motionPerf.e2e.test.ts` after `pnpm --filter @polaris-key/admin build`.
- Machine: Apple M5 Pro, 18 cores, macOS 27, shared with many agents. **The load average was far above 4 for the whole session**: `uptime` read 21 / 21 / 29 before the first run, 82 / 39 / 36 during it, 200 / 155 / 98 for the second and 893 / 358 / 189 for the third. The harness works, but rAF was starved by other processes (4 to 19 frames in a 700 ms window instead of about 42), so **the numbers below are not a frame-time measurement of the app; they are pessimistic by an unknown amount and no moment can be called over budget from them.**
- Run 1 (load 21 to 82; the least starved: 19 to 82 frames per moment, p50 16.0 to 17.0 ms):

| Moment                  | frames | p50 ms | p95 ms | max ms |
| ----------------------- | ------ | ------ | ------ | ------ |
| portal: tile to product | 43     | 16.0   | 89.0   | 191.0  |
| portal: free a device   | 33     | 17.0   | 61.0   | 79.0   |
| portal: library load    | 82     | 16.0   | 31.0   | 76.0   |
| console: overview       | 78     | 16.7   | 16.8   | 83.3   |
| console: filter, 8 rows | 42     | 16.7   | 33.3   | 183.3  |
| console: filter, 60     | 19     | 16.7   | 550.0  | 550.0  |
| console: filter, 200    | 4      | 16.6   | 33.4   | 33.4   |
| console: row to record  | 35     | 16.7   | 50.0   | 133.3  |
| console: drawer open    | 46     | 16.7   | 33.4   | 249.9  |

(Run 1 used a looser window, `ms + 400`, and a 5-frame minimum; both were then tightened to the exact window and 2 frames. Runs 2 and 3 on the tightened file, at load 160 to 890, gave 4 to 14 frames for the action moments and p95 from 16.7 to 580 ms: noise.)

- **To do: rerun at a load average below 4** (a quiet machine or CI-like runner) and replace this table; until then S-23 §3.5 (measured on an idle machine) stays the reference, and nothing here shows a regression. Raw JSON of the runs: `/Users/vlad/Repos/pk-wt/_scratch/MO-13.4/perf.json` (last run).
