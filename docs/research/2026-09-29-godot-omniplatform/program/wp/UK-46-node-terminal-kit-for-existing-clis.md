# UK-46 Node terminal kit for existing CLIs

| Field       | Value                                                                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (SDK usability review (2026-10-08))                               |
| Size        | 0.8–1.2 engineer-weeks                                                                                                                  |
| Depends on  | [UK-51](UK-51-terminal-drop-in-contract.md)                                                                                             |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [SP-64](SP-64-framework-drop-ins-integration-and-docs.md), [UK-52](UK-52-node-cli-oclif-ink.md) |
| Role        | `pkey-implementer`                                                                                                                      |
| Plan mode   | no                                                                                                                                      |
| Gates       | `ui-snapshots`                                                                                                                          |
| Human input | none                                                                                                                                    |
| Repo        | `vladzaharia/polaris-key`                                                                                                               |

## Framework drop-ins (2026-10-08)

The [framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md) §12.2 changes this package. Where it differs from the text below, it wins.

- `withLicense` becomes `requireLicense` (one name for servers and CLIs); adds `namespace`, `onCollision` and `frame: false`; yargs moves to `./cli/yargs`. Follows UK-51's `cli` rows and exit 4.

## Design language v2 (2026-10-08)

This package follows the [design language](../../../../design/UI-KITS.md#design-language-v2-2026-10-08) (rules DL1–DL18). Its row of the [application matrix](../../../../design/UI-KITS-LANGUAGE-MATRIX.md):

- **Rules:** DL1–DL16 and DL18 in the [terminal form](../../../../design/UI-KITS-LANGUAGE-MATRIX.md#terminal-form); DL17 does not apply.
- **In this kit:** Mounted into a host CLI, the kit keeps the host's look outside its own verbs (`frame: false`): grouped help lists the host's commands first, the product chip heads only the kit's flows, and one call mounts it (DL18). A gated command's refusal prints the DL6 line and exits 4 (UK-51).
- **Minimum check:** Help goldens at 32, 40 and 80 columns; the gated command's outcome goldens at the terminal rows.
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

Node terminal kit for existing CLIs, as the [SDK usability review](../../../2026-10-08-sdk-usability/README.md) §10.2 scopes it. Done when every acceptance criterion holds and the green gate passes.

## Why

Eighteen hands-on trials across Node, React, Python, Swift, Kotlin and Godot (the drop-in kit, your own UI, and a newcomer) averaged 5.3/10. This package fixes what they found; the evidence is in [`findings.json`](../../../2026-10-08-sdk-usability/findings.json) and the review's §5 and §7.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [The SDK usability review](../../../2026-10-08-sdk-usability/README.md): §1, §5, the SDK's part of §7, §10.2 (UK-46) and §10.4.

## Scope

**In:** `registerPolarisCommands` and the yargs adapter take `verbs` (ids or groups; default the config's services plus core verbs; developer verbs opt-in) and `config` (today's `polarisConfig`; `polaris-key.json` after SP-32a); a documented commander `mount`; a collision gives a clear error naming the fix, or skips with a warning on opt-in; grouped help lists the host's commands first; `polarisGate()` and `withLicense(handler)`; yargs on its own subpath.

**Out** (and where it belongs instead):

- The 0.9 rebuilds and renames (→ SP-35, SP-35b and the UK kit packages); anything §10.1 gives an existing package.

## Design notes

- No new copies (tracks.md rule 4): build on the one mechanism this package names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] A host CLI with its own `config`, `update` and `status` registers without throwing.
- [ ] `--help` lists the host's commands first.
- [ ] Gating a host command takes 3 lines or fewer.
- [ ] `tsc` with `skipLibCheck: false` passes in a commander-only project.
- [ ] The SP-33a Node CLI golden is 8 lines or fewer and compiles.
- [ ] `pkey-ux-reviewer` passes every changed screen.
- [ ] The acceptance in "Design language v2 (2026-10-08)" above holds.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its SDK lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set UK-46 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-46 done`.
