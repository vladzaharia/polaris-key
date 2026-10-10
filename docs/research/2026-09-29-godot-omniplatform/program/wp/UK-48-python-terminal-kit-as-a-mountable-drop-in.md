# UK-48 Python terminal kit as a mountable drop-in

| Field       | Value                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (SDK usability review (2026-10-08))                            |
| Size        | 0.8–1.2 engineer-weeks                                                                                                               |
| Depends on  | [UK-51](UK-51-terminal-drop-in-contract.md)                                                                                          |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [SP-64](SP-64-framework-drop-ins-integration-and-docs.md), [UK-53](UK-53-textual-screens.md) |
| Role        | `pkey-implementer`                                                                                                                   |
| Plan mode   | no                                                                                                                                   |
| Gates       | `ui-snapshots`                                                                                                                       |
| Human input | none                                                                                                                                 |
| Repo        | `vladzaharia/polaris-key`                                                                                                            |

## Framework drop-ins (2026-10-08)

The [framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md) §12.2 changes this package. Where it differs from the text below, it wins.

- Adds `namespace` and `onCollision`, and accepts the host's `rich.Console`. Follows UK-51's `cli` rows and exit 4.

## Design language v2 (2026-10-08)

This package follows the [design language](../../../../design/UI-KITS.md#design-language-v2-2026-10-08) (rules DL1–DL18). Its row of the [application matrix](../../../../design/UI-KITS-LANGUAGE-MATRIX.md):

- **Rules:** DL1–DL16 and DL18 in the [terminal form](../../../../design/UI-KITS-LANGUAGE-MATRIX.md#terminal-form); DL17 does not apply.
- **In this kit:** Mounted into argparse, click or typer, the kit keeps the host's look outside its own verbs: it accepts the host's `rich.Console` (the native preset), hides integration flags, and prints locale dates and platform names (DL8). One call mounts it (DL18).
- **Minimum check:** Every verb's goldens at the terminal rows, offline and update-unconfigured included, in both themes; help at 32, 40 and 80 columns.
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

## Goal

Python terminal kit as a mountable drop-in, as the [SDK usability review](../../../2026-10-08-sdk-usability/README.md) §10.2 scopes it. Done when every acceptance criterion holds and the green gate passes.

## Why

Eighteen hands-on trials across Node, React, Python, Swift, Kotlin and Godot (the drop-in kit, your own UI, and a newcomer) averaged 5.3/10. This package fixes what they found; the evidence is in [`findings.json`](../../../2026-10-08-sdk-usability/findings.json) and the review's §5 and §7.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [The SDK usability review](../../../2026-10-08-sdk-usability/README.md): §1, §5, the SDK's part of §7, §10.2 (UK-48) and §10.4.

## Scope

**In:** `register_argparse`, `polaris_click_group` and `polaris_typer_app` take `client=` or `config=` with `version=`; once bound, `--product`, `--trust`, `--base-url`, `--service`, `--config-dir` and the per-verb `--version` are hidden; `verbs=` with `END_USER` as the default; per-verb help; `require_license()` and `require_entitlement()`; the update available state without signed decisions; signed-in only from identity; the bundle name from package metadata until HA-13; no degraded-store line in end-user status; `<Product> sign-in` copy; kebab-case `--json` enums; locale dates and platform names; no private client attributes; the Textual Updates pane wired or removed; `mytool.py` and `tidewater.py` with no argv hack.

**Out** (and where it belongs instead):

- The 0.9 rebuilds and renames (→ SP-35, SP-35b and the UK kit packages); anything §10.1 gives an existing package.

## Design notes

- No new copies (tracks.md rule 4): build on the one mechanism this package names, never beside it.

## Brand transition (2026-10-09)

Applied from the brand and transition integration ([Brand transition decisions](../BRAND-TRANSITION.md)). This section wins over the text below where they differ.

- Align terminal detection in one capability table (env x streams x flags to color, unicode, interactive, animate, links) in the `cli` family of `ui-matrix.json`, run by both kits: CI truthiness over `CI`, `GITHUB_ACTIONS` and `BUILDKITE` (CI=0 or false is not CI); OSC 8 links only on a TTY; the animation rule; no OSC 11 query under NO_COLOR. (sdk-c-09, sdk-c-10, sdk-c-30)
- `activate` with no key reads piped stdin only when it is a file or FIFO, stops at the first non-empty line and gives up after about 2 s with `cli.activate.noKey` (exit 2). [ ] A test with an open, silent stdin returns within the bound; `echo key | activate` still works. (sdk-c-09, sdk-c-10, sdk-c-30)
- Update apply: downloading (bar, '38 of 61 MB · 20 s left'), verifying (spinner, `update.verifying`), ready ('2.5.0 is ready · Restart to finish'), installed only after restart; never '100% · Up to date' while a restart is pending. Up to three What's new lines when the release carries notes. (sdk-c-09, sdk-c-10, sdk-c-30)

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] `python mytool.py sign-in` and `status` work unchanged.
- [ ] A host's `--help` lists only the chosen verbs without integration flags.
- [ ] Every verb has offline and update-unconfigured goldens in both themes.
- [ ] The `require_*` snippets are tested files.
- [ ] The SP-33a Python CLI golden compiles.
- [ ] `pkey-ux-reviewer` passes every changed screen.
- [ ] The acceptance in "Design language v2 (2026-10-08)" above holds.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its SDK lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set UK-48 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-48 done`.
