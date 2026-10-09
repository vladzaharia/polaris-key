# UK-53 Textual screens for host apps

| Field       | Value                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (framework drop-ins (2026-10-08))   |
| Size        | 0.6–0.9 engineer-weeks                                                                                    |
| Depends on  | [UK-48](UK-48-python-terminal-kit-as-a-mountable-drop-in.md), [UK-51](UK-51-terminal-drop-in-contract.md) |
| Unblocks    | none                                                                                                      |
| Role        | `pkey-implementer`                                                                                        |
| Plan mode   | no                                                                                                        |
| Gates       | `ui-snapshots`                                                                                            |
| Human input | none                                                                                                      |
| Repo        | `vladzaharia/polaris-key`                                                                                 |

## Design language v2 (2026-10-08)

This package follows the [design language](../../../../design/UI-KITS.md#design-language-v2-2026-10-08) (rules DL1–DL18). Its row of the [application matrix](../../../../design/UI-KITS-LANGUAGE-MATRIX.md):

- **Rules:** DL1–DL16 and DL18 in the [terminal form](../../../../design/UI-KITS-LANGUAGE-MATRIX.md#terminal-form); DL17 does not apply.
- **In this kit:** Textual has widgets, focus and its own CSS, so the language maps closely: two panes once the terminal is at least 100 columns, otherwise one; spacing in whole cells; one `variant="primary"` button in the accent and tonal blocks for the rest, never bracketed buttons (§8, terminal board); `AUTO_FOCUS` on the primary with Textual's focus style as the ring; Textual's own theme as the native preset.
- **Minimum check:** Textual snapshot tests at 80×24, 60×24, 40×24 and 120×40, both themes.
- **Acceptance:** the matrix rows above pass, and a UX review (`pkey-ux-reviewer`) of the built screens gives each a quality verdict of good or better.

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

## Goal

Textual screens for host apps, as the [framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md) §12.1 scopes it. Done when every acceptance criterion holds and the green gate passes.

## Why

The owner asked for drop-ins that gate a server route or a CLI command with the app's signed licence document, verified offline ([plan](../../../2026-10-08-framework-drop-ins/README.md) §1, §4). The owner approved the plan and decided its eleven questions on 2026-10-08. This is its package UK-53 (optional).

## Read first

- `AGENTS.md` (always).
- [The framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md): §1, §4, §5–§7 and §9 as they bear on this package, and §12.1 (row UK-53).

## Scope

**In:** `PolarisGateScreen` and the other screens a Textual host app pushes, over `polaris_key.ui.core` and UK-51's rows.

**Out** (and where it belongs instead):

- Pages and parts other framework packages own (§12.1); anything the plan gives an existing package (§12.2).

## Design notes

- No new copies (tracks.md rule 4): build on the one mechanism the plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] A Textual host pushes `PolarisGateScreen` and the gate resolves to the host's callback.
- [ ] The acceptance in "Design language v2 (2026-10-08)" above holds.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set UK-53 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-53 done`.
