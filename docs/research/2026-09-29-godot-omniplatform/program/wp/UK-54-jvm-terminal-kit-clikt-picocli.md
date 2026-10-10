# UK-54 JVM terminal kit on Mordant, with Clikt and picocli adapters

| Field       | Value                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (framework drop-ins (2026-10-08)) |
| Size        | 1.8–2.4 engineer-weeks                                                                                  |
| Depends on  | [UK-51](UK-51-terminal-drop-in-contract.md), [UK-02b](UK-02b-ui-fixtures-parity.md)                     |
| Unblocks    | none                                                                                                    |
| Role        | `pkey-sdk-porter`                                                                                       |
| Plan mode   | no                                                                                                      |
| Gates       | `ui-snapshots`, `ci:kotlin`                                                                             |
| Human input | none                                                                                                    |
| Repo        | `vladzaharia/polaris-key`                                                                               |

## Design language v2 (2026-10-08)

This package follows the [design language](../../../../design/UI-KITS.md#design-language-v2-2026-10-08) (rules DL1–DL18). Its row of the [application matrix](../../../../design/UI-KITS-LANGUAGE-MATRIX.md):

- **Rules:** DL1–DL16 and DL18 in the [terminal form](../../../../design/UI-KITS-LANGUAGE-MATRIX.md#terminal-form); DL17 does not apply.
- **In this kit:** Mordant draws the same frames as the Node and Python kits: its terminal detection decides ANSI-16 or truecolor and honours `NO_COLOR`; the rail, glyphs and compaction order are shared; Clikt and picocli mount the verbs with one call (DL18).
- **Minimum check:** The terminal rows; text parity with the Node and Python kits at 80×24.
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

## Plan follow-through (2026-10-09)

Approved [`plans/UK-51.md`](../plans/UK-51.md) (2026-10-09) bears on this package: Runs UK-51's `mount`, `help` and `gate` rows for Clikt and picocli, adds the JVM runner, and flips `ui.cli.contract` to required on `jvm` in its own plan. UK-51 lands first (after UK-03 and UK-45); a `cli` row that a natural adapter fails goes back as a bug against the row.

## Goal

JVM terminal kit on Mordant, with Clikt and picocli adapters, as the [framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md) §12.1 scopes it. Done when every acceptance criterion holds and the green gate passes.

## Why

The owner asked for drop-ins that gate a server route or a CLI command with the app's signed licence document, verified offline ([plan](../../../2026-10-08-framework-drop-ins/README.md) §1, §4). The owner approved the plan and decided its eleven questions on 2026-10-08. This is its package UK-54 (optional).

## Read first

- `AGENTS.md` (always).
- [The framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md): §1, §4, §5–§7 and §9 as they bear on this package, and §12.1 (row UK-54).

## Scope

**In:** A new JVM terminal kit rendered with Mordant, running UK-51's `cli` rows, plus `im.plrs.key:polaris-key-cli-clikt` (a Clikt `PolarisCommands(client).endUser()` and `requireLicense`) and `-cli-picocli` (a gate execution strategy reading `@RequiresLicense`).

**Out** (and where it belongs instead):

- Pages and parts other framework packages own (§12.1); anything the plan gives an existing package (§12.2).

## Design notes

- No new copies (tracks.md rule 4): build on the one mechanism the plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] A Clikt and a picocli host mount the verbs and gate a command; a refusal exits 4.
- [ ] The Mordant screens match UK-51's `cli` rows.
- [ ] The acceptance in "Design language v2 (2026-10-08)" above holds.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set UK-54 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-54 done`.
