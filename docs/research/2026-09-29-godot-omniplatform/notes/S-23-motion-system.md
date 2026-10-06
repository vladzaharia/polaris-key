> Research note for [Godot on Polaris Key](../README.md), 2026-10-05. Spike S-23, commissioned by
> the lead on the owner's request of 2026-10-05: "Motion should also be applied to the existing
> customer portal and console. Let's do a full spike and wave just adding that in." The owner's
> wider brief, relayed with it, is a modern, animated experience ("animations are going to be key
> here"), with **one motion system for everything**. The sign-in spec (SIGN-IN.md §3.18, on
> `design/sign-in-consolidated`, written in parallel) defers its token names to this note
> ("where S-23 renames or retunes a token, S-23 wins"). Like S-21 and S-22, S-23 has no program
> brief; §10 registers a new `MO-` work-package namespace. Research, prototypes and measurement
> only: no product code changed, nothing was deployed, no account or credential was used. File
> references are to the tree at `53b72083a` (`A/` = `packages/admin/src/`, `B/` =
> `packages/brand/`, `M/` = `docs/research/2026-09-29-godot-omniplatform/prototype/motion/`).

# S-23: One motion system for the portal and the console

Evidence tags, as in the other notes: **[V]** read in the code, the docs or a vendor's page;
**[M]** measured here; **[S]** summarised from a secondary source; **[I]** inference or design;
**[U]** not verified. Glossary (AGENTS.md rule 4): product, device, tier. "Licence" in prose,
`license` in identifiers and UI copy.

> **Owner decisions (delegated to Claude, 2026-10-05).** The owner delegated the open choices to
> the lead. Each is taken with the recommended option; the reasoning is in the section cited.
>
> | #   | Decision                                                                                                                                                                                                                                                                                                                                                                               | Why (section)                                                                                           |
> | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
> | D1  | **No animation library.** CSS keyframes and transitions, the View Transitions API and a ~1.3 KB utility layer in `A/ui/motion/`. Revisit only for gesture physics (drag-to-dismiss sheets), and then measure first.                                                                                                                                                                    | `motion/react` costs 46.3 KB gzip, more than the whole portal chunk (44.0 KB) (§3.6)                    |
> | D2  | **View Transitions for route changes, tabs, list mutations and dialog steps**; names are applied **only during the kind of transition they belong to** (`html[data-vt]`); browsers without the API swap instantly (the route fades in).                                                                                                                                                | Supported in Chromium 153 and WebKit 26.6, CSP-clean (§3.2); permanent names paint over scrims (§3.4)   |
> | D3  | **Reduced motion is an instant swap, everywhere** (OS setting or the in-app preference): every duration token is 0, no View Transition starts, no shimmer, no burst. This **supersedes UI-KITS §4.8's "keeps only the opacity change, at `fast`"** for every surface, matching SIGN-IN §3.18 and the owner's "instant swaps". An in-app **Reduce motion** preference is added (MO-12). | The owner's words; one rule for everything (§6.6)                                                       |
> | D4  | **One token set** (§5). S-23 adopts SIGN-IN's `moderate` (260 ms) and `stagger` (30 ms, at most 6); `quick` (160 ms) is **not** added (exits use `fast`); new `micro` 80 ms, `deliberate` 480 ms, `emphasized` and `spring` easings, distances `xs`–`xl`, scales, delays.                                                                                                              | SIGN-IN defers to S-23; fewer steps (§5)                                                                |
> | D5  | **Success moments burst plain sparks** (six dots in the section accent), once per moment key, never the Polaris mark; the check draws once.                                                                                                                                                                                                                                            | BRAND §7.5: the star never moves; EXPERIENCE §0.7's "star scattered" is reworded (§6.4)                 |
> | D6  | **Only loading indicators loop** (the spinner and the skeleton shimmer). The 12 `animate-pulse` sites are retired for shaped skeletons.                                                                                                                                                                                                                                                | BRAND §7.5 "no looping or decorative motion" stays (§4.3)                                               |
> | D7  | **Budgets:** nothing that blocks input runs longer than `slow` (320 ms) plus `micro`; a list transition names at most **30 rows**, then only the rows on screen; transform and opacity only, with three named exceptions.                                                                                                                                                              | The page takes no input during a View Transition (§3.3); 200 named rows stalled 950 ms at 6× CPU (§3.5) |
> | D8  | **Dynamic values go through the CSSOM** (custom properties and `view-transition-name` set by the motion layer), **never markup**: no `style=""`, no injected `<style>`, no inline script. JSX `style` stays limited to today's nine geometry sites.                                                                                                                                    | `style-src 'self'` blocks attributes and elements but not CSSOM or WAAPI (§3.1)                         |
> | D9  | **Every e2e suite runs with reduced motion**; one motion smoke suite runs with motion on and asserts token durations, View Transitions and zero CSP violations.                                                                                                                                                                                                                        | Layout lint and screenshots stay deterministic (§6.8)                                                   |
> | D10 | **The motion wave is phase MO** (§10): tokens, then the layer, then e2e determinism, then the portal and console areas in parallel slices that avoid the in-flight UX, PX, UK and SP branches.                                                                                                                                                                                         | §10                                                                                                     |

## 1. Question

What should move in the customer portal and the console, how, and through which one system that
also feeds the UI kits and the sign-in card, under the Worker's strict CSP, with reduced motion
honoured everywhere, at 60 fps on a low-end machine, without a heavy library, and in which work
packages, so it lands alongside the in-flight UX, PX and UK branches without collisions?

## 2. Short answer

- **Today the console and the portal barely move** [M][V]. Overlays enter with a 120 ms rise
  (`animate-pk-in`) and **none animates out**: Radix unmounts them at once (frame strip
  `M/shots/today-portal-activate-close.png`: the Activate dialog is gone in the first frame).
  Route changes are instant swaps with **zero running animations**
  (`today-portal-library-to-product.png`). There are no press states, no tab indicator, no exit,
  list, counter, meter or status motion, and no success moment. One utility is broken
  (`animate-pk-refetch` has no keyframe) and the portal's smooth scroll ignores reduced motion (§4).
- **One system** (§5, §6): the brand's motion tokens grow from 4 durations and 3 easings to 6
  durations, 5 easings, 5 distances, 3 scales, a stagger and 2 delays, generated by `gen:brand`
  into CSS, Tailwind, TS, JSON and the kit languages. Nine named patterns (**enter, exit, morph,
  expand, shared-element, stagger-list, success, skeleton, press**) are CSS classes and data
  attributes. Route changes, tabs, list mutations and dialog steps use **same-document View
  Transitions**, gated by type. A 1.3 KB layer (`viewTransition`, `Presence`, `countTo`,
  `setMeter`, `highlight`, `celebrateOnce`) does the rest.
- **It works under the CSP** [M]. CSSOM custom properties, the Web Animations API,
  constructable sheets, `view-transition-name` through the CSSOM and `startViewTransition` all run
  with **zero violations** in Chromium 153 and WebKit 26.6; only `style=""` and `<style>` are
  blocked, as intended. Both prototypes ran 32 moments under the Worker's policy with zero
  violations.
- **It is fast enough** [M]. At 4× and 6× CPU throttling every prototype moment keeps a p50 of
  16.7 ms. The one long frame on a route change is the new page's render (it is the same with an
  instant swap). Long lists were the trap: naming 200 rows stalled 616–950 ms at 4–6×; naming only
  the rows on screen brings it to a 150 ms worst frame.
- **Three measured pitfalls shaped the rules**: the page **takes no input during a View
  Transition** (so transitions stay short and a second click skips the first); **permanently
  named elements paint over live overlays** (so names are gated by transition type); and a **list
  that shrinks at the bottom of the page jumps** unless the main region is part of the transition
  (§3.3–§3.4).
- **Prototypes** (§7): `M/portal.html` (Library → product → activate → free a device) and
  `M/console.html` (overview → licence record → drawer → confirm → toast, ⌘K), both themes,
  reduced-motion toggle, frame strips under `M/shots/`.
- **Work** (§10): **13 packages, MO-01 to MO-13**, about 5.2–8.3 engineer-weeks. **MO-01 (tokens)
  is ready now**; MO-02 (the layer) follows it; MO-03 (e2e determinism) gates the area packages;
  MO-04, MO-08 and MO-09 touch no in-flight file; MO-05 to MO-07 and MO-10 to MO-12 wait on named
  branches.

## 3. Method and environment

**Machine** [M]: Apple M5 Pro, 18 cores, 64 GB, macOS 27.0 (26A428); local only, no network
services. **Toolchain**: Node 22.13.1 (`mise exec node@22`), pnpm 10.33.2, Playwright 1.63.0
(Chromium 153.0.8010.12, WebKit 26.6; the Firefox build would not launch on this macOS, see §11),
esbuild 0.25.12, `motion` 14.0.0 (measured in a scratch directory, not added to the repo). Tree
`53b72083a`.

```sh
# Install, build the SPA, and take today's screenshots (both themes, every portal state, Core pages)
mise exec node@22 -- pnpm install --frozen-lockfile
mise exec node@22 -- pnpm --filter @polaris-key/admin... build
PK_SHOTS_DIR=<dir>/portal mise exec node@22 -- npx vitest run -c vitest.e2e.config.ts e2e/portal.e2e.test.ts  # 39 passed
PK_SHOTS_DIR=<dir>/core   mise exec node@22 -- npx vitest run -c vitest.e2e.config.ts e2e/core.e2e.test.ts    # 4 passed
# Today's motion as frame strips (the built SPA on the e2e fixtures, under the Worker CSP)
( cd packages/admin && mise exec node@22 -- npx tsx ../../docs/research/2026-09-29-godot-omniplatform/prototype/motion/tools/real-app.ts )
# CSP and feature probe; prototype strips; frame times
mise exec node@22 -- node docs/research/2026-09-29-godot-omniplatform/prototype/motion/tools/csp-probe.mjs
mise exec node@22 -- node docs/research/2026-09-29-godot-omniplatform/prototype/motion/tools/strips.mjs
mise exec node@22 -- node docs/research/2026-09-29-godot-omniplatform/prototype/motion/tools/perf.mjs
# Bundle cost (scratch directory): npm i motion@14 react@19 esbuild@0.25, then for each entry
npx esbuild entry.js --bundle --minify --format=esm --external:react --external:react-dom --external:react/jsx-runtime | gzip -9 | wc -c
```

The code audit (§4) was a read of every overlay, router, list, meter and feedback component
in `A/`, cross-checked against the screenshots. The frame strips slow every animation to ×0.1 (or
×0.25 for page loads) with the DevTools `Animation.setPlaybackRate`, capture eight frames and label
them in animation time; I looked at every strip and fixed what looked wrong (§3.4).

### 3.1 The CSP: what is allowed [M]

`tools/csp-probe.mjs` serves a page with the console's policy (`script-src 'self'; style-src
'self'`, no `'unsafe-inline'`; `packages/worker/src/securityHeaders.ts:40-41`) and tries each mechanism. Raw output:
`M/shots/csp-probe.json`.

| Mechanism                                                                                                                          | Chromium 153 | WebKit 26.6 | Violation?                |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------ | ----------- | ------------------------- |
| `el.style.setProperty("--pk-meter", …)` (CSSOM)                                                                                    | applies      | applies     | none                      |
| `el.style.opacity = …` (CSSOM; React's `style` prop)                                                                               | applies      | applies     | none                      |
| `el.setAttribute("style", …)`                                                                                                      | blocked      | blocked     | `style-src-attr`          |
| `el.animate(…)` (Web Animations API, `linear()` easing)                                                                            | runs         | runs        | none                      |
| an injected `<style>` element                                                                                                      | blocked      | blocked     | `style-src-elem`          |
| a constructable stylesheet (`adoptedStyleSheets`)                                                                                  | applies      | applies     | none                      |
| `view-transition-name` through the CSSOM                                                                                           | applies      | applies     | none                      |
| `document.startViewTransition` (+ `types`)                                                                                         | runs         | runs        | none                      |
| `view-transition-name: match-element`, `-class`                                                                                    | supported    | supported   | n/a                       |
| `@starting-style`, `transition-behavior: allow-discrete`, `linear()`, `@property`, `sibling-index()`, `animation-timeline: view()` | supported    | supported   | n/a                       |
| `interpolate-size: allow-keywords`                                                                                                 | supported    | **no**      | n/a (so expand uses grid) |

So the system needs **no CSP change and no new hash**: keyframes and `::view-transition-*` rules
live in the bundled stylesheet; dynamic values go through the CSSOM.

### 3.2 View Transitions are usable now [M][S]

Same-document View Transitions, `types`, `match-element` and `view-transition-class` all work in
the two engines measured. Firefox ships same-document View Transitions from version 144 [S]; it
could not be measured here (§11), and the fallback (an instant swap with the route fading in)
covers it either way.

### 3.3 The page takes no input during a View Transition [M]

The probe starts a 1.5 s transition and clicks a button mid-way, with a real mouse event. In both
engines the click **does not reach the handler** (`clickDuringViewTransition: false`). Hence D7:
route and tab transitions stay at `base` plus `micro` (about 280 ms), and `viewTransition()` skips
a running transition when a new one starts, so a fast second click is never swallowed.

### 3.4 What the strips caught [M]

Each was visible in a strip, fixed in `M/motion.css` or `M/motion.js`, and re-recorded:

1. **Permanent names paint over overlays.** With `view-transition-name` always on the main
   region and the hero, the Activate dialog's step change lifted the whole page above its scrim
   (the page lit up mid-transition). Fix: names apply only under `html[data-vt="<type>"]`.
2. **A shrinking list at the bottom of the page jumps.** Removing a device shortened the page, the
   browser clamped the scroll, and the live card slid under the animating rows. Fix: during a list
   transition the list's container, its other children and the main region are named too, so the
   clamp glides (`portal-07-remove-confirm-dark.png`). Holding the page height instead only moved
   the jump to the end.
3. **A cross-fade doubles every line.** Old and new pages at half opacity read as noise. Fix: a
   fade-through (old out in `fast`, new in after `micro`).
4. **Shared text stretches** when its two ends differ in aspect (an inline tile name and a
   full-width `h1`). Fix: both ends `width: fit-content`.
5. **Recreated rows cannot pair.** Filtering re-rendered every row, so all left and all came back.
   React keeps keyed rows, so the console gets this for free; the prototype keeps its row elements.
6. **The art morph ghosted** two copies of the image. Fix: show only the new snapshot, scaled from
   the old box.
7. **Timers are not animations.** A burst removed on a 1.2 s timer vanished under slowed playback,
   and a count driven by `performance.now()` raced the slowed timeline. Fix: remove on
   `finished`, count on frame timestamps.

### 3.5 Frame times [M]

`tools/perf.mjs`: rAF intervals for 700 ms after the action (1.4–1.5 s for page loads), Chromium
153, 1280 × 800, CPU throttling 1×, 4× and 6×. Raw: `M/shots/perf.json`.

| Moment                                   | 1× p95 / max (ms) | 4× p95 / max | 6× p95 / max | Instant-swap baseline at 6× |
| ---------------------------------------- | ----------------- | ------------ | ------------ | --------------------------- |
| portal: tile → product (shared element)  | 16.7 / 66.7       | 16.7 / 166.8 | 16.8 / 266.7 | 16.8 / 183.3                |
| portal: free a device (list)             | 16.7 / 16.8       | 16.8 / 33.3  | 16.7 / 66.7  |                             |
| portal: library load (stagger, skeleton) | 16.7 / 16.8       | 16.8 / 16.8  | 16.8 / 16.8  |                             |
| console: overview (count-up, meter)      | 16.8 / 16.8       | 16.8 / 16.8  | 16.8 / 33.4  |                             |
| console: filter, 8 rows (list)           | 16.7 / 16.8       | 16.8 / 33.3  | 16.8 / 50    |                             |
| console: filter, 60 rows (list)          | 33.4 / 50         | 33.3 / 66.7  | 33.3 / 83.4  | 16.8 / 16.8                 |
| console: filter, 200 rows (list)         | 33.4 / 50         | 33.3 / 83.4  | 33.4 / 150   | 16.7 / 33.3                 |
| console: row → record (forward)          | 16.8 / 16.8       | 16.7 / 33.4  | 16.8 / 50    |                             |
| console: drawer open                     | 16.7 / 16.8       | 16.8 / 33.3  | 16.7 / 16.8  |                             |

p50 is 16.7 ms in every row. The tile → product worst frame is the product page's own render (the
baseline has it too). The list rows are **after** the viewport-bounded naming; before it, with
every row named, the same runs measured 60 rows at 4×/6× p95 33/50, max 100/150, and **200 rows at
4×/6× max 617/950 ms** (11 and 5 frames in the window). That is D7's 30-row budget. rAF measures
the main thread; compositor-driven transforms can stay smooth when it stalls, so these are upper
bounds on visible jank [I].

### 3.6 Bundle cost [M]

Minified ESM, React external, `gzip -9`:

| Import                                                     | gzip       |
| ---------------------------------------------------------- | ---------- |
| `motion/react`: `motion`, `AnimatePresence`                | 46.3 KB    |
| `motion/react`: `motion`, `AnimatePresence`, `LayoutGroup` | 46.7 KB    |
| `motion/react`: `LazyMotion` + `m` + `domAnimation`        | 31.9 KB    |
| `motion`: `animate`, `stagger` (vanilla)                   | 22.2 KB    |
| `motion/mini`: `animate`                                   | 3.7 KB     |
| **S-23 layer** (`M/motion.js`)                             | **1.3 KB** |
| **S-23 stylesheet** (`M/motion.css`, minified)             | 2.5 KB     |

For scale, today's portal chunk is 44.0 KB gzip and the console's entry 54.1 KB
(`pnpm --filter @polaris-key/admin build`). A full motion library would roughly double the portal's
JavaScript for what CSS and View Transitions already do.

## 4. The audit: what moves today, and what should

Sources: the code read [V],
the e2e screenshots (110 portal, 16 Core) and today's strips [M].

### 4.1 Today's motion system [V]

- Tokens: `--pk-duration-{instant 0, fast 120, base 200, slow 320}` and
  `--pk-ease-{standard, enter, exit}`, collapsing to 0 ms under reduced motion (`B/css/tokens.css`
  91-97, 415-422). BRAND §7.5: functional motion only; the star never moves.
- Keyframes in `A/styles.css:97-157`: `pk-in` (4 px rise, 0.98 scale, `fast`), `pk-overlay-in`,
  `pk-spin` (0.7 s, kept under reduced motion on purpose), `pk-collapse-down/up` (Radix height).
  **No exit keyframe exists.** `animate-pk-refetch` is used (`A/ui/loading.tsx:57`) but never
  defined.
- No motion library, no `startViewTransition`, no `@starting-style`, no WAAPI. rAF is used only
  for focus timing.
- CSP shims already in place: sonner's and Radix Select's inline `<style>` are stripped, CodeMirror
  adopts a constructable sheet, Radix scroll lock uses `A/lib/styleSingleton.ts` (`vite.config.ts`
  133-231).

### 4.2 Surface by surface

| Surface                                                                                | Today [V][M]                                                                                                                | Gap                                                                    | Pattern (§7)                  | Package             |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------- | ------------------- |
| Dialog, ConfirmDialog (`A/ui/Dialog.tsx:47,115`)                                       | enter `pk-in` + scrim fade; **no exit**; phone bottom sheet uses the same rise                                              | exit; sheet should slide up                                            | enter/exit; sheet             | MO-02, MO-10        |
| Drawer (`A/ui/Drawer.tsx:86`), phone nav (`shell/AppShell.tsx:373`)                    | rises and scales like a dialog; no exit                                                                                     | slide from the edge                                                    | enter/exit (drawer)           | MO-08, MO-10        |
| Popover, Tooltip, ActionMenu, Select, Combobox, DropdownMenu                           | `pk-in`; no exit; not side-aware                                                                                            | side-aware enter, short exit                                           | enter/exit                    | MO-02, MO-08        |
| ⌘K palette (`shell/CommandPalette.tsx:143-148`), portal JumpPalette                    | enter only                                                                                                                  | exit; results never animate while typing                               | enter/exit                    | MO-08, MO-05        |
| Toasts (sonner, `A/ui/toast.tsx`)                                                      | sonner's own 200–500 ms transitions; off under reduced motion                                                               | map to tokens                                                          | enter/exit                    | MO-02               |
| Console routes (`console/router.tsx`, `AppShell` `PageContent key`)                    | instant remount; Suspense fallback is a spinner + "Loading…"                                                                | route transition; skeleton fallback                                    | morph (route), skeleton       | MO-04, MO-10        |
| Portal routes (`portal/router.ts`)                                                     | instant; **no scroll reset, no focus move**; smooth section scroll **ignores reduced motion** (`ProductPage.tsx:180`)       | route transition; scroll and focus; gate smooth scroll                 | morph (route), shared-element | MO-05               |
| Record tabs (`console/components/PageTabs.tsx`), SegmentedControl                      | underline and thumb snap                                                                                                    | indicator morph, panel fade-through                                    | morph (tab)                   | MO-04               |
| Data tables (`A/ui/data-table/DataTable.tsx`), filter chips                            | rows and chips appear and vanish; bulk bar pops                                                                             | row enter/exit/reorder, chip pop, bar presence                         | stagger-list, list, enter     | MO-09               |
| Expanding rows (portal Remove inline confirm, `DevicesCard.tsx:158-237`; `<details>`)  | instant, focus managed                                                                                                      | expand                                                                 | expand                        | MO-06               |
| Loading                                                                                | spinners in 4 places; `PageSkeleton` 25 sites, `Skeleton` 60; **12 `animate-pulse` sites** contradict "blocks do not pulse" | shaped skeletons with a shimmer that stops under reduced motion        | skeleton                      | MO-09, MO-10        |
| Meters and counters (`portal/components/SeatMeter.tsx`, `ui/charts/*`, Keys countdown) | static; widths by class table or SVG attribute                                                                              | fill transitions, count-up, countdown ring                             | meter, count, countdown       | MO-06, MO-09, MO-11 |
| Status (`StatusPill`, `SignedBadge`)                                                   | text and colour swap                                                                                                        | colour ease, word pops                                                 | status                        | MO-09               |
| Success moments (EXPERIENCE §0.7)                                                      | **none exist** (activation is a static banner, `ActivateDialog.tsx:228-248`)                                                | first activation, device freed, first release, licence created         | success                       | MO-06, MO-11        |
| Hover and press (`A/ui/Button.tsx:25-40`)                                              | `transition-colors`; `hover:brightness-110` **snaps** (filter not transitioned); **no `active:` state anywhere**            | press scale; transition the filter; tile lift                          | press, lift                   | MO-08, MO-07        |
| Library and Discover grid (`LibraryTile.tsx`, `ProductArt.tsx`)                        | static cards; art pops in as it loads                                                                                       | stagger on first load, lift, art fades in on decode, grid ↔ list morph | stagger-list, lift, morph     | MO-07               |
| Product hero                                                                           | instant                                                                                                                     | tile art morphs into the hero                                          | shared-element                | MO-05               |
| Focus ring (`A/styles.css:198-215`)                                                    | instant                                                                                                                     | **keep instant** (never animate focus in)                              | —                             | —                   |

### 4.3 Jank and debt found

`animate-pk-refetch` undefined; `animate-pulse` on 12 sites (`ui/charts/StatTile.tsx:82-83`,
`platform*.tsx`, `global/Home.tsx:282`) against the Skeleton rule; one `transition-all`
(`components/ui/Tabs.tsx:37`, legacy, removed by UX-10); `hover:brightness-110` snapping; smooth
scroll not gated; the phone nav "drawer" rising instead of sliding; the portal not resetting
scroll on navigation.

## 5. Tokens

Proposed for `B/src/tokens/scales.ts` `MOTION` (MO-01), emitted by `gen:brand` to `css/tokens.css`
(`--pk-*`), `css/theme.css` (Tailwind `--ease-*`), `tokens.json`, `src/generated/tokens.ts` and,
through `gen-kit.ts`, to Swift, Kotlin and GDScript constants. **New** marks additions.

| Group    | Token                                       | Value                                                                                             | Used for                                                                                   |
| -------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| duration | `instant`                                   | 0 ms                                                                                              | instant swaps                                                                              |
|          | `micro` **new**                             | 80 ms                                                                                             | press in, hover colours, the fade-through gap, leaving rows                                |
|          | `fast`                                      | 120 ms                                                                                            | exits, popovers, the old view leaving                                                      |
|          | `base`                                      | 200 ms                                                                                            | route and tab fade-through, list moves, overlay scrim                                      |
|          | `moderate` **new** (SIGN-IN §3.18)          | 260 ms                                                                                            | morph (dialog or card size), expand, check draw                                            |
|          | `slow`                                      | 320 ms                                                                                            | dialog and drawer enter, shared-element morph, pill pop                                    |
|          | `deliberate` **new**                        | 480 ms                                                                                            | success burst, count-up, highlight fade (never blocks input)                               |
|          | `shimmer` **new**                           | 1600 ms                                                                                           | the skeleton sweep period                                                                  |
| easing   | `standard`, `enter`, `exit`                 | unchanged                                                                                         |                                                                                            |
|          | `emphasized` **new**                        | `cubic-bezier(0.05, 0.7, 0.1, 1)`                                                                 | shared elements, drawer, sheet, meters                                                     |
|          | `spring` **new**                            | `linear(…)`, 4 % overshoot (the UI-KITS 1.04 ceiling); `standard` where `linear()` is unsupported | press release, pill pop                                                                    |
| distance | `xs` `sm` `md` `lg` `xl` **new**            | 2, 4, 8, 12, 24 px                                                                                | hover lift; enter rise; exit and step slide; entering view; sheet rise                     |
| scale    | `press`, `enter`, `pop` **new**             | 0.98, 0.98, 0.9                                                                                   | `:active`; overlay enter; pill and chip pop                                                |
| stagger  | `stagger-step`, `stagger-max` **new**       | 30 ms, 6                                                                                          | stagger-list (≤ 180 ms total)                                                              |
| delay    | `delay-skeleton`, `delay-highlight` **new** | 150 ms, 1600 ms                                                                                   | skeleton grace (no flash on fast loads); new-row tint. **Not** collapsed by reduced motion |

Reduced motion collapses every duration and `stagger-step` to 0, under
`@media (prefers-reduced-motion: reduce)` **and** `:root[data-motion="reduce"]` (the in-app
preference, MO-12). The kits get the same numbers: `KIT_MOTION_MEASURES` keeps `pressScale` 0.98,
`sheetScale` 0.98, `stepSlide` 8 (= `md`), `sheetRise` 24 (= `xl`), `overshoot` 1.04; `KIT_MOTION.web`
rows are renamed to the pattern names; the platform rows (SwiftUI springs, Material motion
scheme, Godot tweens) keep their native curves, as UI-KITS §4.8 says.

**SIGN-IN §3.18 alignment** (its branch is separate; the edit is proposed, not made here): replace
`--pk-duration-quick` with `--pk-duration-fast` for exits; keep `moderate` and `--pk-stagger`
(spelled `--pk-stagger-step`, cap 6); enter slides use `--pk-motion-distance-lg` (12 px), exits
`md` (8 px), the stagger rise `sm` (4 px, not 6); the enter delay is `micro` (80 ms, not 90); the
skeleton sheen period is `shimmer` (1600 ms, not 1.2 s); the "is yours" particles are **sparks, not
small stars** (D5).

## 6. Patterns and rules

The reference implementation is `M/motion.css` (patterns) and `M/motion.js` (layer); MO-02 ports
both. Every pattern is a class or a data attribute.

### 6.1 The nine patterns

| Pattern             | Where                                                                                    | Motion                                                                                                                                       | Implementation                                                                                                                                                                           | Reduced motion                |
| ------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| **enter**           | dialogs, popovers, menus, tooltips, toasts                                               | opacity + `sm` rise + `enter` scale, `slow`·`enter` (dialogs) or `fast` (popovers, from their `data-side`)                                   | `[data-state="open"]` keyframe; today's `animate-pk-in` keeps working                                                                                                                    | instant                       |
| **exit**            | the same                                                                                 | the reverse, `base`·`exit` (popovers `fast`)                                                                                                 | `[data-state="closed"]` keyframe; Radix keeps the node until `animationend`; MO-02 keys it on the existing `.animate-pk-in` class so no component file changes                           | instant                       |
| **morph**           | route (sibling), drill-down (forward/back), tab, dialog step, theme                      | fade-through: old out `fast`, new in `base` after `micro`; forward/back add an 8→12 px slide; a dialog's panel morphs its size at `moderate` | same-document View Transition with `html[data-vt]` gating the names (`pk-main`, `pk-tabpanel`, `pk-indicator`, `pk-dialog`, `pk-card`)                                                   | no transition starts          |
| **shared-element**  | Library tile → product hero (art, title); licence row key → record header; tab indicator | the element flies to its new box, `slow`·`emphasized`                                                                                        | names `pk-hero`, `pk-hero-title`, `pk-key`, set on the source by the layer through the CSSOM for one transition; both ends of text `width: fit-content`; art shows only the new snapshot | instant                       |
| **stagger-list**    | first load of the Library grid, Overview tiles, attention list                           | each item enters, 30 ms apart, at most 6 steps                                                                                               | `.pk-stagger > *` with `sibling-index()`, `nth-child` fallback; mount only, never on refetch or while typing                                                                             | all at once                   |
| **list** (mutation) | free a device, delete or create a row, filter, sort                                      | leaving rows fade (`micro`), the rest close the gap (`base`), entering rows rise after `fast`; new rows tinted, then faded                   | View Transition `list`: rows `match-element` with class `pk-row`; the container (`.pk-vt-scope`), its children and the main region named; **≤ 30 rows, then only rows on screen**        | instant; the tint still shows |
| **expand**          | Remove / Replace inline confirm, disclosure, inline notices                              | the region opens `moderate`·`standard`, its content fades in after `micro`                                                                   | `.pk-expand[data-open]` animating `grid-template-rows` 0fr→1fr; closed content `visibility: hidden` (out of the tab order)                                                               | instant                       |
| **success**         | first activation, device freed, first release, licence created, store connected          | the check draws (`moderate`), six sparks burst (`deliberate`), once per moment key                                                           | `.pk-check` (`stroke-dashoffset`), `.pk-burst` (`aria-hidden`), `celebrateOnce(key)` with a stored key                                                                                   | a static check                |
| **skeleton**        | every content load                                                                       | appears after 150 ms; a sheen sweeps every 1.6 s; content fades in (`base`)                                                                  | `.pk-skeleton::after` translating (compositor only); `.pk-skeleton-group` delay; `aria-busy` on the region                                                                               | static blocks                 |
| **press**           | every button, tile, chip                                                                 | 0.98 on `:active` (`micro` in, `fast`·`spring` out); colours at `micro`; tiles lift 2 px with a shadow fade                                  | `.pk-pressable`, `.pk-lift` (shadow on a pseudo-element, opacity only); pointer devices only                                                                                             | no scale                      |

Smaller pieces on the same tokens: **status** (pill colours ease at `base`; a new word pops at
`slow`·`spring`), **meter** (`transform: scaleX(var(--pk-meter))` set through the CSSOM, or a
segment's `data-used` with a one-off pulse), **count** (`countTo()` on frame timestamps, with a
visually hidden twin holding the final number), **countdown** (an SVG ring draining over
`--pk-countdown`; under reduced motion only the seconds text changes), and **theme** (one View
Transition cross-fade of the page).

### 6.2 Performance rules

1. Animate `transform` and `opacity` only. Three named exceptions: **expand**
   (`grid-template-rows`, one element at a time, `moderate`), **colour** on small elements (pills,
   chips, buttons), and **SVG `stroke-dashoffset`** (the check and the countdown ring).
2. Never `transition: all`; never animate `width`, `height`, `top`, `left`, `box-shadow` or
   `filter` per frame (fade a pseudo-element's opacity instead).
3. `will-change` only while animating, never in a stylesheet rule that is always on.
4. Lists: stagger caps at 6; a list transition names at most 30 rows, then only the rows on screen
   (measured, §3.5); virtualised tables (over 200 rows, `VIRTUALIZE_ABOVE`) never animate row
   entry on scroll; typing never triggers motion (palette results, search-as-you-type tables).
5. Nothing that blocks input lasts longer than `slow` + `micro`; a new transition skips the running
   one.
6. Timers never drive motion: removal waits for `animation.finished`, counts read frame timestamps.
7. The budget is checked by MO-13's frame test at 4× CPU: p95 ≤ 33 ms for every moment.

### 6.3 View Transitions, in detail

- `viewTransition(update, { type, shared, list })` wraps a **synchronous** update (React:
  `flushSync` inside the callback), sets `html[data-vt]`, applies one-shot `shared` names through
  the CSSOM, and returns `{ updateCallbackDone, finished }`. Focus moves on `updateCallbackDone`
  (the DOM is final; the snapshot is only a picture), never after the animation.
- Types: `route` (sibling page: the main region fades through), `forward` and `back` (drill-down by
  route depth, computed in the router from the hash path, not from `routes.ts`), `tab`, `list`,
  `dialog`, `theme`.
- The chrome (top bar, sidebar, product switcher) is **never named**, so it stays live and still.
- Query-string-only changes (filters in the URL, `useTableUrlState`) use `list`, not `route`.
- The console's unsaved-changes blocker resolves **before** the transition starts.
- Without the API, or under reduced motion: `update()` runs directly; the new route fades in with
  `.pk-route-in` where the API is missing.

### 6.4 Success moments

EXPERIENCE §0.7's list stands. Each moment shows once (per product in the console, per account in
the portal) with `celebrateOnce(key)`, a check and six sparks in the section accent, within
`deliberate`, never blocking input, never a pill, never the Polaris mark: EXPERIENCE's "the burst is
the stationary star scattered" is reworded in this change to "plain sparks" (BRAND §7.5 wins).

### 6.5 Accessibility

- **No motion hides state.** The final state is in the DOM before the animation runs; every
  status is a word; motion is never the only cue (a new row is tinted and announced; a freed seat is
  counted in text).
- **Focus through transitions.** Radix returns focus at close start; route focus moves on
  `updateCallbackDone`; expand moves focus to the region's heading and back to the trigger on
  cancel (today's behaviour, kept); the portal gains route focus and scroll reset (MO-05).
- **Live regions** announce once per change (existing `announce()`); a count-up's visible text is
  `aria-hidden` while its twin holds the value.
- **Focus rings never animate.**
- **Vestibular:** no parallax, no zoom of the page, slides ≤ 12 px except edge-anchored drawers and
  sheets; nothing flashes.
- WCAG 2.3.3 (animation from interactions) is met by D3 and the in-app preference.

### 6.6 Reduced motion

One rule (D3): **instant swaps**. The tokens collapse, `viewTransition()` does not start a
transition, the shimmer and the burst are hidden, countdown rings stay full, smooth scrolling
becomes instant. Delays that are not motion (the skeleton's 150 ms grace, the new-row tint's
1.6 s) remain. The spinner keeps turning (BRAND: a loading indicator, not decoration). The
in-app preference (MO-12) writes `html[data-motion="reduce"]` from the account menu (console)
and Account → Appearance (portal), stored like the theme. It is applied from the entry modules,
not the hashed pre-paint script, so `adminCsp.ts` does not change.

### 6.7 CSP

Keyframes, patterns and `::view-transition-*` rules live in the bundled `motion.css`; the layer
writes only data attributes, classes and CSSOM properties (§3.1). No `style=""`, no `<style>`, no
inline script, no new host: `adminCspParity` and `e2e/csp.e2e.test.ts` stay green unchanged, and
MO-03's smoke suite asserts zero violations during every pattern.

### 6.8 Testing

- **Determinism:** every e2e context (`layout`, `portal`, `core`, `csp`, `config`,
  `distribution`, `kit`, `portalMedia`) sets Playwright's `reducedMotion: "reduce"`, so layout lint
  and screenshots see final states (MO-03).
- **Motion smoke** (`e2e/motion.e2e.test.ts`, motion on): a dialog's enter and exit run with token
  durations (`getAnimations()`), the node is removed after the exit; a route change starts and
  finishes a View Transition with the right `data-vt`; a list mutation names ≤ 30 rows; zero CSP
  violations; with `reducedMotion: "reduce"`, no animation runs and no transition starts.
- **Unit:** the layer's reduced-motion branches, `Presence`, `countTo`, budget logic (jsdom has no
  View Transitions, so the layer must no-op cleanly there).
- **Motion lint** (`test/motionLint.test.ts`): bans `transition-all`, arbitrary `duration-[…]` and
  `ease-[…]`, raw `ms` in class names, `animate-pulse` (after MO-09/MO-10 clear it; allowlisted
  until then) and JSX `style` that sets `transition`, `animation` or `transform`.

## 7. Prototypes [M]

`M/portal.html` and `M/console.html` run on the real brand tokens, under the Worker's CSP
(`M/tools/serve.mjs`), in both themes, with a reduced-motion toggle. The flows:

- **Portal:** Library loads (skeleton → staggered tiles) → **Nightfall** (the tile's art and name
  fly into the hero; the page slides forward) → **Activate license** (dialog enters; Activate →
  busy → the panel morphs to "Nightfall is yours on this Mac" with the check and sparks) → Done
  (dialog exits; "This Mac" rises into the device list, tinted; the meter's third segment fills;
  the count goes 2 → 3; "All seats used" pops) → **Remove** on a device (the confirm expands; focus
  to its heading) → **Remove device** (the row fades, the list closes up, the meter drains, 3 → 2,
  the pill leaves; toast with **Undo**) → **← Library** (the hero flies back into its tile).
- **Console:** Overview loads (skeleton → tiles stagger, numbers count up, the refreshed-devices
  meter fills, "Your first release is live" draws its check once) → **Licenses** (fade-through) →
  facet chip **Active** (the other rows leave, survivors glide) → a licence row (forward; its key
  flies into the record header) → **Devices** tab (indicator moves, panel fades through) → a device
  (drawer slides in) → **Deauthorize…** (confirm over the drawer) → confirm (both exit; the row's
  pill eases to Deauthorized with a tint; toast with **Undo**); ⌘K palette; theme cross-fade.

Frame strips (×0.1 unless noted) in `M/shots/`: `portal-02-tile-to-product-{dark,light,dark-reduced}`,
`portal-04-activate-success-light`, `portal-05-device-added-dark`, `portal-06-remove-expand-dark`,
`portal-07-remove-confirm-{dark,dark-reduced}`, `portal-08-back-to-library-dark`,
`console-01-overview-load-dark` (×0.25), `console-03-filter-chip-dark`, `console-04-row-to-record-light`,
`console-05-tab-switch-dark`, `console-06-drawer-open-dark`, `console-08-deauthorize-toast-dark`,
`console-09-palette-dark`, and today's `today-portal-activate-close` and
`today-portal-library-to-product`. `shots/strips-report.txt`: every one of the 32 recorded moments
had **zero CSP violations**; the reduced-motion strips show the final state from the first frame.

## 8. Recommendation

Adopt §5 and §6 as the one motion system, owned by `packages/brand` (tokens) and
`packages/admin/src/ui/motion` plus `src/motion.css` (patterns), with the kits mapping the same
tokens through UK-01's pipeline and the sign-in card adopting the names. Land it as phase MO (§10),
foundation first. Keep the system small: no library (D1), View Transitions with gated names (D2),
instant swaps under reduced motion (D3).

## 9. What changes outside this note

- **EXPERIENCE.md**: new §7.2 "Motion" (the shared system, the patterns by surface); §0.7 burst
  reworded (sparks, `deliberate`); §9 skeleton row points to the pattern; §13 gains the MO wave.
  Made in this change.
- **PORTAL.md**: §0.3 and §7 "Motion" bullets replaced by pointers to the system; §9 item 9 says
  instant swaps; §11 gains the MO cross-reference. Made in this change.
- **ADMIN.md**: §0.3 contract line and a new §5.12 "Motion" (patterns per template, budgets,
  View Transition types, the e2e rule). Made in this change.
- **BRAND.md §7.5 and §4 table** (MO-01, proposed text): "Motion is functional and expressive
  within the tokens: state changes, navigation, and the brief success moments of EXPERIENCE §0.7.
  Only loading indicators loop. No parallax. The star never animates…" plus the new token rows.
- **UI-KITS.md §4.8** (MO-01, proposed): "Reduced motion swaps instantly (S-23 D3); `"none"` is the
  same", replacing "keeps only the opacity change, at `fast`"; web rows renamed to the S-23 pattern
  names.
- **SIGN-IN.md §3.18** (its own branch; proposed in §5): the token alignment above.
- **program/**: `check.mjs` and the schema accept the `MO` prefix; `workpackages.json` gains phase
  MO and 13 packages with briefs; `README.md` §8 describes the phase.

## 10. Work packages (phase MO)

All `pkey-implementer`, repo `vladzaharia/polaris-key`, no plan mode (no wire, no protocol, no
corpus). File lists were checked against `git diff --name-only main...<branch>` for every unmerged
local branch on 2026-10-05; "waits on" names the branch whose files it shares.

| Id    | Package                                                                                                                                     | Size (wk) | Deps          | Files (main ones)                                                                                                                                                                      | In-flight overlap → waits on                                                        |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| MO-01 | Motion tokens in `@polaris-key/brand` (+ BRAND §7.5, UI-KITS §4.8)                                                                          | 0.3–0.5   | —             | `B/src/tokens/{scales,kit}.ts`, `B/scripts/{gen,gen-kit}.ts`, generated outputs, BRAND.md, UI-KITS.md                                                                                  | `wp/U-04` regenerates the same generated files: rebase and run `gen:brand`          |
| MO-02 | The motion layer: `A/ui/motion/*`, `A/motion.css`, exits for every overlay, toasts on tokens, `pk-refetch`, motion lint                     | 0.6–1.0   | MO-01         | new `A/ui/motion/`, new `A/motion.css`, `A/main.tsx`, `A/portal/main.tsx`, new tests                                                                                                   | none                                                                                |
| MO-03 | E2E determinism (reduced motion in every suite) and the motion smoke suite                                                                  | 0.3–0.5   | MO-02         | `e2e/*.e2e.test.ts` (one context option each), new `e2e/motion.e2e.test.ts`                                                                                                            | `wp/PX-20`, `wp/PX-16` edit `portal.e2e.test.ts`: one-line rebase                   |
| MO-04 | Console navigation: route and drill-down transitions, record tabs, SegmentedControl                                                         | 0.4–0.6   | MO-03         | `console/router.tsx`, `console/components/PageTabs.tsx`, `ui/SegmentedControl.tsx`, tests                                                                                              | none                                                                                |
| MO-05 | Portal navigation: route transitions, scroll and focus, tile → hero, smooth scroll gated, JumpPalette                                       | 0.4–0.6   | MO-03         | `portal/router.ts`, `portal/components/product/ProductHeader.tsx`, `portal/pages/{ProductPage,AccountPage}.tsx`, `portal/components/JumpPalette.tsx`                                   | none (the tile is named by a delegated click handler, not by editing `LibraryTile`) |
| MO-06 | Portal devices and activation: expand, list exit, seat meter, count, Activate step morph and success, FreeDevicePage                        | 0.5–0.8   | MO-03, SP-08  | `portal/components/{SeatMeter,ActivateDialog}.tsx`, `portal/components/product/DevicesCard.tsx`, `portal/pages/FreeDevicePage.tsx`                                                     | `wp/SP-08` (DevicesCard, FreeDevicePage); PX-17 also edits ActivateDialog           |
| MO-07 | Portal Library and Discover: stagger, lift and press, art fade-in, grid ↔ list morph, "Added just now" ring                                 | 0.4–0.6   | MO-03, PX-16  | `portal/pages/{LibraryPage,DiscoverPage}.tsx`, `portal/components/{LibraryTile,LibraryList,LibraryToolbar,ProductArt,DiscoverTile}.tsx`                                                | `wp/PX-16`, `integ/identity-store-1`                                                |
| MO-08 | Console overlays and controls: Drawer slide, side-aware popovers and menus, press states, Button filter fix, CommandPalette                 | 0.4–0.6   | MO-02         | `ui/{Drawer,Popover,Tooltip,ActionMenu,Select,Combobox,Button,IconButton,Switch,RadioCards,CopyButton}.tsx`, `console/shell/CommandPalette.tsx`                                        | none                                                                                |
| MO-09 | Console data surfaces: table rows, facet chips, bulk bar, status pills, charts, StatTile, Skeleton shimmer, RefetchBar                      | 0.6–1.0   | MO-03         | `ui/data-table/{DataTable,FilterBar}.tsx`, `ui/{StatusPill,SignedBadge,Skeleton,loading,Stepper}.tsx`, `ui/charts/*`                                                                   | `feat/license-delete` edits `DataTable.tsx`                                         |
| MO-10 | Console shell: phone bottom sheet and nav drawer, skeleton route fallback, sidebar, StatePages, `animate-pulse` retired on platform pages   | 0.4–0.7   | MO-02         | `ui/Dialog.tsx`, `console/shell/{AppShell,Sidebar,StatePages,ShortcutSheet}.tsx`, `console/pages/{platform,platformOperations,platformSettings,platformStores}.tsx`, `global/Home.tsx` | `wp/UX-10`, `integ/ux-1a-ha` (shell, Dialog); ST-06/ST-01b (`platformSettings`)     |
| MO-11 | Console moments and counters: EXPERIENCE §0.7 celebrations, key-rotation countdown and refreshed meter, Overview and Home attention stagger | 0.4–0.6   | MO-09         | `console/pages/core/{Overview,Keys}.tsx`, `console/pages/global/Home.tsx`, `console/pages/license/CreateLicenseDialog.tsx`                                                             | `wp/UX-29` (Keys), four branches on `Overview.tsx`                                  |
| MO-12 | Reduce-motion preference (console account menu, portal Account → Appearance)                                                                | 0.2–0.3   | MO-02         | `A/main.tsx`, `A/portal/main.tsx`, `console/shell/{ThemeMenu,UserMenu}.tsx`, `portal/components/AccountMenu.tsx`, `portal/pages/AccountPage.tsx`                                       | `wp/UX-10` (menus)                                                                  |
| MO-13 | Motion QA closeout: real-app strips of every pattern, the 4× frame budget, docs                                                             | 0.3–0.5   | MO-04 … MO-12 | `e2e/motion.e2e.test.ts` (extended), `packages/docs/…/contribute/` page, ADMIN `components.md`                                                                                         | none                                                                                |

**Ready now:** MO-01. **Then:** MO-02 → MO-03, and in parallel after MO-02: MO-08, MO-10 (when
UX-10 merges) and MO-12 (when UX-10 merges). **After MO-03:** MO-04, MO-05 and MO-09 at once;
MO-06 when SP-08 lands; MO-07 when PX-16 lands. MO-11 after MO-09 and UX-29. MO-13 last. Total
5.2–8.3 engineer-weeks; the critical path is MO-01 → MO-02 → MO-03 → MO-09 → MO-11 → MO-13
(about 2.5–4 weeks).

The sign-in card's motion is not an MO package: SIGN-IN §3.18 assigns it to the UK and I packages
it lists; they consume MO-01's tokens and MO-02's layer.

## 11. Limits

- **Firefox was not measured.** Playwright's Firefox build exits at launch on macOS 27.0 here
  ("Could not find profile folder"), also outside the sandbox. Its View Transitions support is
  from the vendor's release notes [S]; the fallback covers a miss.
- **One machine.** CPU throttling stands in for a low-end device; GPU-bound cases (a weak
  integrated GPU compositing many snapshots) are not covered. MO-13 should repeat §3.5 on a real
  low-end laptop if one is available [U].
- **Prototypes are not the app.** The list and shared-element rules were tuned on prototypes;
  React's keyed rendering is assumed to keep row identity [I], which MO-09's smoke test must show.
- **React's own `<ViewTransition>`** was not evaluated; the layer wraps `startViewTransition` with
  `flushSync`. If React ships it stable, MO-04/MO-05 may switch [U].

## 12. Sources

- [V] `packages/admin/src/styles.css`, `ui/*`, `console/router.tsx`, `console/shell/AppShell.tsx`,
  `portal/router.ts`, `portal/components/*`, `vite.config.ts`, `packages/worker/src/securityHeaders.ts`,
  `packages/brand/src/tokens/{scales,kit}.ts`, `packages/brand/css/tokens.css`.
- [V] `docs/design/BRAND.md` §7.5, `UI-KITS.md` §4.8, `EXPERIENCE.md` §0.7, §9, §13,
  `PORTAL.md` §0.3, §7, §9, `ADMIN.md` §0.3, §5; `SIGN-IN.md` §3.14, §3.18 on
  `design/sign-in-consolidated` (read 2026-10-05).
- [M] `M/tools/csp-probe.mjs` → `M/shots/csp-probe.json`; `M/tools/strips.mjs` →
  `M/shots/*.png`, `M/shots/strips-report.txt`; `M/tools/perf.mjs` → `M/shots/perf.json`;
  `M/tools/real-app.ts` → `M/shots/today-*.png`; the portal and Core e2e suites with
  `PK_SHOTS_DIR` (screenshots kept locally, not committed).
- [S] MDN, "View Transition API" and Firefox 144 release notes (same-document view transitions),
  not re-read for this note beyond the support claim.
