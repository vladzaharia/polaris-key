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
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set UK-54 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-54 done`.
