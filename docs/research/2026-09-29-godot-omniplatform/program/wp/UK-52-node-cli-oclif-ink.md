# UK-52 Node CLI frameworks, should tier: the `@polaris-key/oclif` plugin and Ink components

| Field       | Value                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (framework drop-ins (2026-10-08)) |
| Size        | 1.2–1.6 engineer-weeks                                                                                  |
| Depends on  | [UK-46](UK-46-node-terminal-kit-for-existing-clis.md), [UK-51](UK-51-terminal-drop-in-contract.md)      |
| Unblocks    | none                                                                                                    |
| Role        | `pkey-implementer`                                                                                      |
| Plan mode   | no                                                                                                      |
| Gates       | `ui-snapshots`                                                                                          |
| Human input | none                                                                                                    |
| Repo        | `vladzaharia/polaris-key`                                                                               |

## Design language v2 (2026-10-08)

This package follows the [design language](../../../../design/UI-KITS.md#design-language-v2-2026-10-08) (rules DL1–DL18). Its row of the [application matrix](../../../../design/UI-KITS-LANGUAGE-MATRIX.md):

- **Rules:** DL1–DL16 and DL18 in the [terminal form](../../../../design/UI-KITS-LANGUAGE-MATRIX.md#terminal-form); DL17 does not apply.
- **In this kit:** The oclif plugin gates a command with one static field (DL18) and prints the kit's refusal line (DL6). Ink's `<PolarisGate>` prints the terminal kit's frames: the shape from `useStdout()`, the same compaction order, rail and glyphs.
- **Minimum check:** Ink goldens equal to the Node kit's at the terminal rows; the oclif refusal output at 80×24 and 40×24.
- **Acceptance:** the matrix rows above pass, and a UX review (`pkey-ux-reviewer`) of the built screens gives each a quality verdict of good or better.

## Goal

Node CLI frameworks, should tier: the `@polaris-key/oclif` plugin and Ink components, as the [framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md) §12.1 scopes it. Done when every acceptance criterion holds and the green gate passes.

## Why

The owner asked for drop-ins that gate a server route or a CLI command with the app's signed licence document, verified offline ([plan](../../../2026-10-08-framework-drop-ins/README.md) §1, §4). The owner approved the plan and decided its eleven questions on 2026-10-08. This is its package UK-52 (optional).

## Read first

- `AGENTS.md` (always).
- [The framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md): §1, §4, §5–§7 and §9 as they bear on this package, and §12.1 (row UK-52).

## Scope

**In:** A separate package `@polaris-key/oclif` (a plugin with `init` and `prerun` gate hooks, read from a command's `static polarisKey`), and Ink components (`<PolarisGate>`) in `@polaris-key/node/ink`. Both follow UK-51's rows and exit 4. `@polaris-key/oclif` joins `publish-sdks.yml`'s npm tiers and the feed-closure check (P0-52's lockstep set).

**Out** (and where it belongs instead):

- Pages and parts other framework packages own (§12.1); anything the plan gives an existing package (§12.2).

## Design notes

- oclif finds plugins by package name, so it cannot be a subpath (§8).

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] An oclif host gates a command through the plugin and a refusal exits 4.
- [ ] An Ink `<PolarisGate>` renders the kit's states.
- [ ] The acceptance in "Design language v2 (2026-10-08)" above holds.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set UK-52 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-52 done`.
