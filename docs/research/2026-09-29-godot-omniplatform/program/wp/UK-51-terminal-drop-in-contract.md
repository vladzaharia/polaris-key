# UK-51 Terminal drop-in contract: the `cli` family in `ui-matrix.json`, exit 4

| Field       | Value                                                                                                                                                                                                                                                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (framework drop-ins (2026-10-08))                                                                                                                                                                                                                            |
| Size        | 0.4–0.6 engineer-weeks                                                                                                                                                                                                                                                                                                             |
| Depends on  | [UK-02b](UK-02b-ui-fixtures-parity.md)                                                                                                                                                                                                                                                                                             |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [UK-46](UK-46-node-terminal-kit-for-existing-clis.md), [UK-48](UK-48-python-terminal-kit-as-a-mountable-drop-in.md), [UK-52](UK-52-node-cli-oclif-ink.md), [UK-53](UK-53-textual-screens.md), [UK-54](UK-54-jvm-terminal-kit-clikt-picocli.md), [UK-59](UK-59-built-kit-boards-refresh.md) |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                                                                                                                                                              |
| Plan mode   | yes: executes the approved plan [framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md) §7.1 and §9.3                                                                                                                                                                                                          |
| Gates       | `plan-mode`, `corpus`, `drift-gate`                                                                                                                                                                                                                                                                                                |
| Human input | none                                                                                                                                                                                                                                                                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                          |

## Design language v2 (2026-10-08)

This package follows the [design language](../../../../design/UI-KITS.md#design-language-v2-2026-10-08) (rules DL1–DL18). Its row of the [application matrix](../../../../design/UI-KITS-LANGUAGE-MATRIX.md):

- **Rules:** DL6, DL7 and DL8 as data, in the [terminal form](../../../../design/UI-KITS-LANGUAGE-MATRIX.md#terminal-form).
- **In this kit:** The `cli` rows pin the language for every terminal kit: a refused gate is a refusal with its fix (▲ and the command that resolves it), never a failure (✗); its copy keys come from the catalogs; it exits 4.
- **Minimum check:** The `cli` family's rows; no screens.
- **Acceptance:** the `cli` rows encode DL6–DL8 and pass; the UX review happens on the screens UK-46, UK-48 and UK-52–UK-54 render from them.

## Goal

Terminal drop-in contract: the `cli` family in `ui-matrix.json`, exit 4, as the [framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md) §12.1 scopes it. Done when every acceptance criterion holds and the green gate passes.

## Why

The owner asked for drop-ins that gate a server route or a CLI command with the app's signed licence document, verified offline ([plan](../../../2026-10-08-framework-drop-ins/README.md) §1, §4). The owner approved the plan and decided its eleven questions on 2026-10-08. This is its package UK-51.

## Read first

- `AGENTS.md` (always), and `CLAUDE.md` (plan mode).
- [The framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md): §1, §4, §5–§7 and §9 as they bear on this package, and §12.1 (row UK-51).

## Scope

**In:** Execute §7.1 and §9.3: a `cli` family in `ui-matrix.json` — verb ids and sets (`END_USER` default, developer verbs opt-in), mount and collision outcomes (`polaris-verb-collision`), help grouping (`cli.help.group`), the gate outcome for each gate state × TTY × `--json`, and exit 4. `EXIT.licenseRequired = 4` in Node's `cli/json.ts` and Python's exit table (`status` keeps exit 1). `uiMatrixVersion` becomes 2.

**Out** (and where it belongs instead):

- The framework adapters (→ UK-46, UK-48, UK-52, UK-53, UK-54).

## Design notes

- The planner turns the research README §7.1 and §9.3 into a short `plans/UK-51.md` for owner approval before any code.
- Exit 4 matches `gh` for "requires authentication" (decision 10).

## Brand transition (2026-10-09)

Applied from the brand and transition integration ([Brand transition decisions](../BRAND-TRANSITION.md)). This section wins over the text below where they differ.

- [ ] Status's revoked, expired and version refusals print ▲ with the fix command rows, never ✗; the reason and date appear only if the wire carries them; gate refusals exit 4, status exits 1, a network failure exits 1. (sdk-c-08)

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 28 mockup item(s):** `kitboard:terminal:sign-in-device-code`, `kitboard:terminal:sign-in-device-code~py`, `kitboard:terminal:activate-masked-key`, `kitboard:terminal:activate-masked-key~py`, `kitboard:terminal:device-limit`, `kitboard:terminal:device-limit~py`, `kitboard:terminal:status-update-finished`, `kitboard:terminal:status-update-finished~py`, `kitboard:terminal:blocked-status`, `kitboard:terminal:blocked-status~py`, `kitboard:terminal:boot-healthy-offline`, `kitboard:terminal:boot-healthy-offline~py`, `kitboard:terminal:grouped-help`, `kitboard:terminal:grouped-help~py`, `kitboard:terminal:fallbacks`, `kitboard:terminal:fallbacks~py`, `kitboard:terminal:cols-60`, `kitboard:terminal:cols-60~py`, `kitboard:terminal:short-40x12`, `kitboard:terminal:short-40x12~py`, `kitboard:terminal:narrow-32x24`, `kitboard:terminal:narrow-32x24~py`, `kitboard:terminal:ended-result-block`, `kitboard:terminal:ended-result-block~py`, `kitboard:terminal:offline-request-120`, `kitboard:terminal:offline-request-120~py`, `kitboard:terminal:parity-json`, `kitboard:terminal:pipe-quadrant`.
- `kitboard:terminal:pipe-quadrant`: Draw a pipe/non-TTY quadrant on terminal.html (UK-59) and cover it in UK-51's contract rows.

## Acceptance criteria

- [ ] The `cli` family pins the verb sets, the collision and help rules, the gate outcomes and exit 4.
- [ ] A refused gate exits 4 and, with `--json`, prints the `error` code (decision 10).
- [ ] `parity:check` and `gen:constants -- --check` pass.
- [ ] The acceptance in "Design language v2 (2026-10-08)" above holds.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set UK-51 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-51 done`.
