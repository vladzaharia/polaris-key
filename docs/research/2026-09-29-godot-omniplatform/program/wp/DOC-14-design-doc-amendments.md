# DOC-14 Design-doc amendments: the B15 P0 fixes and the brand v2 text in BRAND, UI-KITS, EXPERIENCE, ADMIN, PORTAL and SIGN-IN

| Field       | Value                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | DOC: Documentation: one docs site with Help, Developers and Operate (docs/research/2026-10-08-docs/) (UX coverage (2026-10-09)) |
| Size        | 0.5–0.8 engineer-weeks                                                                                                          |
| Depends on  | none                                                                                                                            |
| Unblocks    | none                                                                                                                            |
| Role        | `pkey-implementer`                                                                                                              |
| Plan mode   | no (no wire change)                                                                                                             |
| Gates       | `docs-links`                                                                                                                    |
| Human input | none                                                                                                                            |
| Repo        | vladzaharia/polaris-key                                                                                                         |

## Goal

The design docs say what the decisions say, so a builder reading them is not misled.

## Why

B15 lists the doc fixes but allocated no package. Stale text includes UI-KITS 4.3 (QR beside the code at 560 px, retired by DL14), UI-KITS 4.2 and the web docs (publishableKey, dropped by SETUP D18), EXPERIENCE 0.2 and 5.1, ADMIN 6.1 and 6.2, BRAND 10 (no 500/600) against 1.6, and BRAND 7.6 row heights (36/44) against the 56 px console.

## Read first

- AGENTS.md and the relevant skill.
- `program/ux-coverage.md` (the item list this package closes) and `program/ux-waves.md` (where it sits in the schedule).
- Brand transition decisions `program/BRAND-TRANSITION.md` (B-numbers) and the design docs the work touches.

## Scope

**In:**

- UI-KITS 4.3 and 4.2, EXPERIENCE 0.2 and 5.1, ADMIN 6.1, 6.2 and the 0.5 source-precedence note, BRAND 7.4 (focus ring follows the service, B17), 7.6, 10 and 11.
- BRAND: the action-neutral role (4.x, 5.4), 7.7 empty-state acceptance, 7.8 service icons, and 14 'marketing expression', naming table and intensity table.
- SIGN-IN 6.6 and 3.17 step 4: loginHint and nameHint are dropped (PX-W18, UK-44); say so.
- PORTAL 5.3 lapsed-page row as PX-28 records it.
- The marketing glossary drift list (outlet, Release channels, Content packs, 'alpha, beta and stable') as a table for the website owner.

**Out** (and where it belongs instead):

- Any code or mockup change.

## Corrections found against the code (2026-10-10)

- Most B15 fixes were already in the docs when this package started (UI-KITS 4.2 and 4.3,
  EXPERIENCE 0.2, ADMIN 6.1 and 6.2, BRAND 7.6, 10 and 14). The package finished the rest and
  removed the contradictions between the six docs: sidebar width 240 px (the code), the top-bar
  surface, the portal display h1 (48/52), the Ship builds identity in ADMIN 2.4, the primary
  button in BRAND 5.4, the `--pk-ring` row in BRAND 11, and the stale decision logs.
- `loginHint` and `nameHint`: PX-W18 and UK-44 are `dropped` (PX-W18 merged into I-08, which keeps
  only the wire parameters). The kits and SDKs send no hints. UK-42 still lists UK-44 as a
  dependency; that is a graph follow-up, not a doc change.
- The web kit mockup `docs/design/ui-kits/web.html` still shows `publishableKey`; mockups are out
  of scope here.

## Screens and items this package closes

- no mockup screen; the items are listed in `ux-coverage.json` under this package id

## UX gate

New package from the UX coverage pass (2026-10-09). A built screen is done only when `pkey-ux-reviewer` passes it in BUILT mode and the pass is recorded: `node check.mjs --ux-review DOC-14 pass "<evidence>"`. No wire change; do not derive APIs, entitlements or permissions from any mockup.

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

- [ ] The docs-links gate passes.
- [ ] grep finds no remaining 'publishableKey' in UI-KITS or the web docs, and no 'QR beside the code' text.
- [ ] The green gate passes (AGENTS.md), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm <the package's own tests>
```

## Hand-off

What downstream packages rely on from this one is listed in its Unblocks row. The role agent sets `--set DOC-14 in-review` when it hands off; after review, and after the UX review is recorded, the lead adds the last commit `--set DOC-14 done`.
