# UK-56 Kit mockups refresh: the design language on the boards of the platforms with no built kit (visionOS, tvOS and watchOS in `apple.html`; `desktop.html`, `windows.html`, `linux.html`, `qt.html`) and their kit flows in the mockups artifact, in both presets

| Field       | Value                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (design language v2 (2026-10-08))                                                                                                                                                                                                                                                                                                    |
| Size        | 1.5–2 engineer-weeks                                                                                                                                                                                                                                                                                                                                                                                       |
| Depends on  | none                                                                                                                                                                                                                                                                                                                                                                                                       |
| Unblocks    | [UK-06](UK-06-electron-kit.md), [UK-08](UK-08-swiftui-macos.md), [UK-10](UK-10-compose-desktop.md), [UK-12](UK-12-python-qt.md), [UK-21](UK-21-tauri-bridge.md), [UK-24](UK-24-appkit-kit.md), [UK-26](UK-26-visionos-kit.md), [UK-27](UK-27-tvos-kit.md), [UK-33](UK-33-watchos.md), [UK-59](UK-59-built-kit-boards-refresh.md), [UK-60](UK-60-windows-native-kit.md), [UK-61](UK-61-gnome-native-kit.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                                                                                                                                         |
| Plan mode   | no                                                                                                                                                                                                                                                                                                                                                                                                         |
| Gates       | the boards render (`render.cjs`) in both themes; `pnpm ui:lint` on the boards                                                                                                                                                                                                                                                                                                                              |
| Human input | none                                                                                                                                                                                                                                                                                                                                                                                                       |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                                                                                  |

## Design language v2 (2026-10-08)

This package follows the [design language](../../../../design/UI-KITS.md#design-language-v2-2026-10-08) (rules DL1–DL18). Its row of the [application matrix](../../../../design/UI-KITS-LANGUAGE-MATRIX.md):

- **Rules:** DL1–DL18.
- **In this kit:** Draws the rows of UK-06, UK-08, UK-10, UK-12, UK-21, UK-24, UK-26, UK-27 and UK-33 as boards: each platform's DL1 shape variants, both presets for the gate, sign-in and device limit, and, where a row says to evaluate, the starting point drawn with the open question in its caption.
- **Minimum check:** Every redrawn board rendered by `render.cjs` in both themes at its shape variants; `pnpm ui:lint` on the boards.
- **Acceptance:** the boards pass `pnpm ui:lint` with no new exception, and a UX review in mockup mode gives each board a quality verdict of good or better.

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

## Goal

The boards the next kits are reviewed against show the design language. Every board of a platform
without a built kit is redrawn to DL1–DL18, with the shape variants DL1 needs and both presets, so
UK-06, UK-08, UK-10 and UK-12 (and the parked UK-21, UK-24, UK-26, UK-27 and UK-33) review against
mockups that agree with the spec.

## Why

The mockups are the reference for every kit's design review, and a disagreement with the spec is
fixed before the review (§7.4). These boards predate the
[design language](../../../../design/UI-KITS.md#design-language-v2-2026-10-08): each draws one
window size, none pairs `polaris-key` with `native`, and the macOS sign-in still shows a QR that
SIGN-IN.md D-67 removed. Without this package, each desktop kit's builder would redraw its own
boards in the middle of a review.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [UI-KITS.md](../../../../design/UI-KITS.md), "Design language (v2, 2026-10-08)", §1.4, §7.1, §7.4
  and §8; the [application matrix](../../../../design/UI-KITS-LANGUAGE-MATRIX.md) rows of the
  packages this unblocks, and its desktop-chrome and hosted-surfaces forms.
- `docs/design/ui-kits/`: the boards, `shared.css`, `shared.js`, `render.cjs` and `REVIEW.md`.
- The built kits' boards (`web.html`, `ios.html`, `android.html`, `godot.html`, `terminal.html`)
  as the language's drawn precedent.
- The mockup kit's spacing and layout rules (`docs/design/mockups/kit/README.md`, "Spacing and
  layout", on `program/dx-mockups`).

## Scope

**In:**

- The boards in `docs/design/ui-kits/`: `apple.html` (visionOS, tvOS and watchOS; the iPad board
  is the built SwiftUI kit's), `desktop.html` (macOS), `windows.html`, `linux.html` and `qt.html`.
- On each: the platform's DL1 shape variants (on desktop, a narrow window, a short landscape window
  and a large window for each flow; on tvOS, the two-pane TV composition; on visionOS, the default
  window and a narrow, tall one), both presets for the gate, sign-in and device limit, the neutral
  refusal callout (DL6), errors under their control (DL7), one primary (DL4), the product header (DL5),
  a keyboard or TV focus shot (DL9), and no QR on any desktop surface (DL14, D-67).
- Where a matrix row says to evaluate (visionOS, watchOS), the starting point it names, drawn with
  the open question in the shot's caption.
- New shots through `render.cjs`, in both themes, 1x and lossless; UI-KITS.md §8's board tables
  updated to them.
- The mockups artifact's sdk area (`docs/design/mockups/screens/sdk/`): kit-flow screens for
  macOS, Windows, GNOME, Qt, tvOS and visionOS beside `sdk.react-*` and `sdk.swiftui-*`, in both
  presets, on the mockup kit's spacing scale.

**Out** (and where it belongs instead):

- The boards of the built kits (`web.html`, `ios.html`, `android.html`, `godot.html`,
  `terminal.html`): each fix round's "mockups should adopt" list goes through the mockups workflow
  (a lead task).
- Any kit code (→ each kit's package).

## Design notes

- Draw from the generated tokens, as §8 does; never a hex value.
- The shapes and idioms come from the matrix rows; do not draw a look the matrix leaves open as
  settled.
- `docs/design/mockups/` lives on `program/dx-mockups` until it merges. If it has not merged when
  this starts, the lead decides whether the artifact half waits or lands on that branch.

## Brand transition (2026-10-09)

Applied from the brand and transition integration ([Brand transition decisions](../BRAND-TRANSITION.md)). This section wins over the text below where they differ.

- Draw the inline step in the Welcome window's end pane as the primary shot for activation and sign-in on desktop, Windows, Linux and Qt boards; keep dialog shots captioned 'presentation: "sheet"' (D-79, B10). No static accent line under title bars; settings provenance groups ('From ' changeable vs 'Managed settings' locked); states grace, revoked and DL7 boot; macOS actions that leave the app carry the external-action glyph; Windows and Linux boards gain sign-in and device-limit frames; all strings from the catalog. Qt activate uses the KDE order only on the KDE form; the key field middle-elides at rest. (sdk-b-12)

## Steps

1. The desktop boards (`desktop.html`, `windows.html`, `linux.html`) and `qt.html`, since must kits
   wait on them.
2. `apple.html`'s tvOS, visionOS and watchOS boards.
3. The artifact's kit-flow screens.
4. Render, lint, and a UX review in mockup mode; fix, then record the review.

## Acceptance criteria

- [ ] Every board listed draws its DL1 shape variants and both presets for the gate, sign-in and
      device limit, in both themes.
- [ ] No desktop board shows a QR, and the tvOS board's QR follows DL14.
- [ ] `pnpm ui:lint` passes on the boards with no new exception in `boards.ts`.
- [ ] UI-KITS.md §8 links every new shot.
- [ ] The acceptance in "Design language v2 (2026-10-08)" above holds.
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
NODE_PATH=packages/admin/node_modules node docs/design/ui-kits/render.cjs
mise exec node@22 -- pnpm ui:lint
```

## Hand-off

UK-06, UK-08, UK-10 and UK-12 record their §7.4 design reviews against these boards. The role
agent sets `--set UK-56 in-review` when it hands off. After review, the lead adds the last commit
of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-56 done`.
