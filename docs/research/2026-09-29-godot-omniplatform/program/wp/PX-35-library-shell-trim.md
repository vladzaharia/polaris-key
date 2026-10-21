# PX-35 Polaris Locker Library shell trim

| Field       | Value                                                         |
| ----------- | ------------------------------------------------------------- |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (Locker UX waves) |
| Size        | 0.2–0.3 engineer-weeks                                        |
| Depends on  | [PX-34](PX-34-library-discover-locker.md)                     |
| Unblocks    | none                                                          |
| Role        | `pkey-implementer`                                            |
| Plan mode   | no                                                            |
| Gates       | portal-e2e; ui-snapshots                                      |
| Human input | none                                                          |
| Repo        | `vladzaharia/polaris-key`                                     |

## Goal

Owner request (2026-10-20), verbatim: "Let's also move 'Activate a License' to the user dropdown menu since we already have a tile for it separately. Maybe also tighten them up a bit to allow for more to show up? The 'missing a license' section should be a sticky footer, and we don't need the current 'Polaris Locker' footer."

## Scope

**In** (lead decisions, 2026-10-20):

1. **Activate moves to the account menu.** Remove the header's "Activate license" button (`packages/admin/src/portal/components/PortalShell.tsx`) at every width and the Activate pill from the phone bar (Library · Discover). Add "Activate a license" (key glyph) as the first item of `AccountMenu`, opening the same modal through `useActivate()`. Keep LibraryKeyTile and the palette's "Activate a license". LibraryEmpty keeps one clear ink primary Activate of its own. Signed-out and other pages reach Activate by the menu, the palette or the tile. `?activate=<key>` still opens the modal.
2. **Remove the "Polaris Locker · Help · Privacy" footer.** Help and Privacy move into AccountMenu as a bottom group (FOOT_LINKS, same destinations). Drop the bottom padding that existed for it; keep room for the phone bar and the sticky strip.
3. **"Missing a license?" becomes a sticky footer** on the Library: `position: sticky; bottom: 0` at the end of the page. Desktop: one line, "Missing a license?" then three compact inline links ("Sent to another email? Add it in Sign-in methods", "Bought on Steam? Connect Steam", "App Store or Google Play? Sign in in the app"). Phones: above the phone bar (`env(safe-area-inset-bottom)`), collapsed to a "Missing a license?" disclosure that expands upward. Raised surface, top border, 44 px targets, neutral ink links with the coral 2 px underline (D9a), no shadow drama; never covers the last tile row (matching bottom padding); axe clean; labelled `complementary`/`region`.
4. **Denser tiles** for Library and Discover: smaller art aspect, tighter padding and gaps, one line of meta. At 1440×900 at least 8 tiles above the fold (4×2); 5 columns at 1920; 2 compact columns at 390 with 44 px targets. Keep the PX-34 fixes (line-clamp-2 names, platform glyphs, attention chips, key tile rule). Text never under 12 px; meta 13–14 px.
5. Update `docs/design/PORTAL.md` and the portal.library / portal.discover mockup compare JSON notes to these decisions.

**Out:** the mockup HTML redraw (follow-up); the Account page (PX-31a), license page (PX-28a), sign-in (PX-14a, PX-15, PX-21), support-code row (I-41).

**Rules:** Polaris Locker only; terse copy; 320/360/390/1440/1920 and 200 % text without sideways scroll; never a disabled primary.

**Tests:** update portal unit and e2e tests (portalResolutions header/footer rows, palette, LibraryEmpty, phone bar), the quality bar (axe, one h1, overflow), and re-record all portal linux baselines once at the end.

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

- [ ] `pkey-ux-reviewer` passes the built screens in BUILT mode (real browser, dark and light, 390, 1440 and 1920 px). Builder self-look done in dark and light at 390, 1440 and 1920; the lead schedules the review.
- [x] Header and footer Activate and the footer are gone; the menu, tile and palette reach Activate.
- [~] At 1440×900 the grid is 4 columns with 271 px tiles (two rows fit in 578 px), 5 columns at 1920, 2 at 390. With the 3-item "Needs you" shelf (the twelve fixture) only the first row is above the fold; with no shelf both rows are (8 tiles).
- [x] The scoped green gate passes (AGENTS.md); all portal baselines re-recorded.

## Build notes (2026-10-20)

- Corrections to the brief: the key tile now fills the rest of the last row (`keyTileSpan(count, 2..5)`) rather than "one cell or a whole row", because the grid has 2, 3, 4 and 5 columns by breakpoint (`tileGrid.ts`) and a half-empty last row failed the presence check. The 5th column comes from tile width (about 235 px at 1700 px and up), not a wider page: PORTAL.md §8 holds the content column at 82 rem and `columnBreaches` enforces it.
- The status pill on tile art moved to the top-right corner (8 px inset), since the denser art leaves no room beside the icon. Meta is the first fact line only; the 8+ grid keeps "Free to use" only.
- The sticky strip is a child of `PortalShell` (after `main`, so it is full-bleed and sticks to the viewport), rendered only on the Library route. `e2e/portalHarness.ts` `axe()` runs with the strip resting in the flow (set through the CSSOM): axe's target-size rule reads whatever a sticky element covers at scroll top as obscured. The sticky behaviour has its own checks in `e2e/portalLibraryTrim.e2e.test.ts`.
- Pre-existing, not from this change: `portal.e2e` "signs in with an email code" waits for the heading "Sign in to Polaris Key" and the sign-in page no longer draws it (sign-in WPs own it).
- Follow-ups: redraw the mockup HTML (portal.library, portal.library-12, portal.library-empty, portal.discover) to the 2026-10-20 decisions; shelf density at 1440×900 if 8 tiles must show with a shelf.

## Fix round (2026-10-20, after the BUILT UX review)

- B1: `MissingLicense` publishes its height as `--pk-strip-h` (ResizeObserver); `styles.css` pads `scroll-padding-bottom` by it (plus the phone bar below `desk`). `portalLibraryTrim` tabs through 3 products at 360, 7 at 1024 and the list at 1440 and asserts no focused control sits under the strip or bar (Chromium only: the harness has no WebKit). `axe()` in `portalHarness.ts` still runs with the strip resting in the flow: axe at the page end reads the sticky header's links as crowding the first rows, so the page-end run fails on rows that are fine; the sticky behaviour itself is covered by `portalLibraryTrim`.
- M1: Activate a license is the strip's first item. M3: one line from `wide`, the disclosure below. M4: the button is first in the DOM (`flex-col-reverse`), the open panel is raised with a header. M5: menu rows `pointer-coarse:min-h-11`. M6: Discover is one column under 400 px, and one or two offers get a centred, wider layout.
- M2: a tile under 13 rem moves More into the name row and drops the action's icon; under 11 rem the icon (with More) stacks above the name and the status pill moves into the meta row; glyphs get their own row. Measured by `useElementWidth`. `portalLibraryTrim` asserts nothing spills out of a tile.
- m1: "Activate a license" and "Sign in from the app" everywhere. The account menu no longer hands focus back to its trigger when Activate opens the dialog.
