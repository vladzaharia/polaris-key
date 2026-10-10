# UK-59 Refresh the built kits' boards from the reviewed builds

| Field       | Value                                                                                                                                                                                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md)                                                                                                                                                                                            |
| Size        | 1–1.5 engineer-weeks                                                                                                                                                                                                                                             |
| Depends on  | [UK-47](UK-47-react-kit-and-gate-fixes-before-uk-05.md), [UK-49](UK-49-swiftui-kit-and-swift-sdk-0-8-x-correctness.md), [UK-50](UK-50-godot-drop-in-fixes-ahead-of-uk-11.md), [UK-51](UK-51-terminal-drop-in-contract.md), [UK-56](UK-56-kit-mockups-refresh.md) |
| Unblocks    | none                                                                                                                                                                                                                                                             |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                               |
| Plan mode   | no (no wire change)                                                                                                                                                                                                                                              |
| Gates       | ui-snapshots, modernity-lint                                                                                                                                                                                                                                     |
| Human input | none                                                                                                                                                                                                                                                             |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                        |

## Plan follow-through (2026-10-09)

Approved [`plans/UK-51.md`](../plans/UK-51.md) (2026-10-09) bears on this package: draw the pipe/non-TTY quadrant on `terminal.html` from UK-51's `gate` rows (four quadrants per refused status; refusals are ▲, never ✗) and refresh the terminal boards.

## Goal

The boards of the platforms that already have a built kit (web, ios, apple iPad, android, godot, terminal) are redrawn from the reviewed builds and agree with UI-KITS.md, DL1-DL18 and the catalog copy. Each frame says whether it is 'Built today' or a 'UK-11 target'.

## Why

UK-56 redraws only the boards of platforms with no built kit. The brand guide reprinted the stale built-kit boards, and the kits' own builders and reviewers compare against them, so the boards must be right first.

## Read first

- `AGENTS.md` and the relevant skill.
- [Brand transition decisions](../BRAND-TRANSITION.md), B10, B14.
- The design docs the decisions amend: `docs/design/BRAND.md`, `docs/design/EXPERIENCE.md`, `docs/design/UI-KITS.md`, `docs/design/PORTAL.md` and `docs/design/ADMIN.md` as they apply.

## Scope

**In:**

- Web: no QR on sign-in; the identity pane per DL1; catalog copy; shape rows 844x390, 640x360, 1180x820, 1920x1080.
- iOS: inline one-form activation and sign-in (sheet only as a labelled alternative); live activity relabelled to a content pack; neutral boot indicator. apple.html iPad from the built SwiftUI renders.
- Android: states, settings and tablet list-detail, expired state with the product icon, phone landscape, small landscape and tablet portrait for gate, sign-in and device limit; add `sdk.compose-activate` and `sdk.compose-sign-in` mockups.
- Godot: two labelled tiers per frame ('Built today' and 'UK-11 target'); QR only on pad-only screens and offline request codes; host-owns-pause note; DL7 loading.
- Terminal: sign-in title 'Sign in with a code'; refusals use ▲ with the fix, exit codes per UK-51 (refused gate 4, status 1); 40- and 32-column frames; a fifth 'pipe' quadrant; no accent line under title bars.
- No tinted strokes, rims or glows on any board (B6).

**Out** (and where it belongs instead):

- Kit code (→ the UK-04..UK-12, UK-47..UK-51 builders).
- Boards of platforms without a built kit (→ UK-56).

## Brand transition (2026-10-09)

New package from the brand and transition integration. Sources: Brand transition B10, B14 (program/BRAND-TRANSITION.md); section changes sdk-a-05, sdk-b-04, sdk-c-01 (merged). No wire change; do not derive APIs, entitlements or permissions from any mockup. Where the brand guide and a current mockup, design-language rule (DL1-DL18) or owner note disagree, the mockup, rule or note wins (B-decisions, source precedence).

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

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 1 mockup item(s):** `kitboard:terminal:pipe-quadrant`.
- `sdk-a-09`: Remove welcome.lede and part.qr.scanInstead from kit-copy/en.json and the 8 locale packs, then regenerate kitCopy (UK-02a is done).
- `B14.7`: UK-41 requires an evidence ledger: a matrix cell is complete only with runtime evidence or a documented N/A.
- `kitboard:terminal:pipe-quadrant`: Draw a pipe/non-TTY quadrant on terminal.html (UK-59) and cover it in UK-51's contract rows.

## Acceptance criteria

- [ ] `render.cjs` renders every board in both themes; `pnpm ui:lint` passes with no new exception.
- [ ] A mockup-mode `pkey-ux-reviewer` rates each board good or better.
- [ ] Board captions say which tier each frame is.
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```
mise exec node@22 -- pnpm <the package's own tests>
```

## Hand-off

What downstream packages rely on from this one is listed in its Unblocks row. The role agent sets `--set UK-59 in-review` when it hands off; after review the lead adds the last commit `--set UK-59 done`.
