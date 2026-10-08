# UK-51 Terminal drop-in contract: the `cli` family in `ui-matrix.json`, exit 4

| Field       | Value                                                                                                                                                             |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (framework drop-ins (2026-10-08))                                                           |
| Size        | 0.4–0.6 engineer-weeks                                                                                                                                            |
| Depends on  | [UK-02b](UK-02b-ui-fixtures-parity.md)                                                                                                                            |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [UK-52](UK-52-node-cli-oclif-ink.md), [UK-53](UK-53-textual-screens.md), [UK-54](UK-54-jvm-terminal-kit-clikt-picocli.md) |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                             |
| Plan mode   | yes: executes the approved plan [ADME.md](../../../2026-10-08-framework-drop-ins/README.md) §7.1 and §9.3                                                         |
| Gates       | `plan-mode`, `corpus`, `drift-gate`                                                                                                                               |
| Human input | none                                                                                                                                                              |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                         |

## Goal

Terminal drop-in contract: the `cli` family in `ui-matrix.json`, exit 4, as the [framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md) §12.1 scopes it. Done when every acceptance criterion holds and the green gate passes.

## Why

The owner asked for drop-ins that gate a server route or a CLI command with the app's signed licence document, verified offline ([plan](../../../2026-10-08-framework-drop-ins/README.md) §1, §4). The owner approved the plan and decided its eleven questions on 2026-10-08. This is its package UK-51.

## Read first

- `AGENTS.md` (always), and `CLAUDE.md` (plan mode).
- [The framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md): §1, §4, §5–§7 and §9 as they bear on this package, and §12.1 (row UK-51).

## Scope

**In:** Execute §7.1 and §9.3: a `cli` family in `ui-matrix.json` — verb ids and sets (`END_USER` default, developer verbs opt-in), mount and collision outcomes (`polaris-verb-collision`), help grouping (`cli.help.group`), the gate outcome for each gate state × TTY × `--json`, and exit 4. `EXIT.licenseRequired = 4` in Node's `cli/json.ts` and Python's exit table (`status` keeps exit 1). `uiMatrixVersion` becomes 2 if UK-02b has shipped, else it rides UK-02b's version 1.

**Out** (and where it belongs instead):

- The framework adapters (→ UK-46, UK-48, UK-52, UK-53, UK-54).

## Design notes

- Exit 4 matches `gh` for "requires authentication" (decision 10).

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] The `cli` family pins the verb sets, the collision and help rules, the gate outcomes and exit 4.
- [ ] A refused gate exits 4 and, with `--json`, prints the `error` code (decision 10).
- [ ] `parity:check` and `gen:constants -- --check` pass.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set UK-51 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-51 done`.
