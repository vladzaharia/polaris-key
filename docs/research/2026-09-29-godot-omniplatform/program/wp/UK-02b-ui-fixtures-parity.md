# UK-02b UI state fixtures and parity rows: shared component/state/copy-key fixtures, `features.json` `ui.*` rows, every SDK's `parity.json` at `planned`

| Field       | Value                                                                                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (must)                                                                          |
| Size        | 1–1.5 engineer-weeks                                                                                                                                  |
| Depends on  | [UK-02](UK-02-copy-fixtures-parity-plan.md), [SP-00](SP-00-parity-registry-plan.md)                                                                   |
| Unblocks    | [UK-03](UK-03-ui-core.md), [UK-07](UK-07-swiftui-ios.md), [UK-09](UK-09-compose-android.md), [UK-11](UK-11-godot-kit.md), [UK-12](UK-12-python-qt.md) |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                                                                                  |
| Plan mode   | yes: executes the approved [`plans/UK-02.md`](../plans/UK-02.md)                                                                                      |
| Gates       | plan mode (executes `plans/UK-02.md`); `pnpm parity:check -- --check`; `gen:constants -- --check` (feature ids); the generated parity docs page       |
| Human input | none                                                                                                                                                  |
| Repo        | `vladzaharia/polaris-key`                                                                                                                             |

## Sign-in alignment (2026-10-05): SIGN-IN.md

[`docs/design/SIGN-IN.md`](../../../../design/SIGN-IN.md) is the canonical sign-in experience, and `plans/I-04.md`
§F (the reconciliation, with delegated decisions 16–24) is its wire counterpart. Where this brief
differs from either, they win. Copy comes from SIGN-IN.md §5.2 (`signin.*`, US "license").
**No device-wire change** (`PROTOCOL_VERSION` 4, `corpusVersion` 2). For this package:

- `LicenseChoice` UI fixtures: loading, many, one, current, keep, new, create, all-full, account-wide, mixed, replace-open, raced, none-keys, none-no-keys, none-replaceable (SIGN-IN.md §6.2).

## Goal

The presentation state machines are specified once as fixtures that every core can run, and the parity registry tracks the UI kit features in every SDK.

## Why

Layer (c) must be the same state machine in every language (§1.3); without fixtures, a React screen and a Godot scene fed the same inputs can disagree. The spec is [`docs/design/UI-KITS.md`](../../../../design/UI-KITS.md); its "Owner decisions (2026-10-05)" header wins over the sections below it.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode).
- `plans/UK-02.md` (approved)
- [UI-KITS.md](../../../../design/UI-KITS.md) §4.1 (components and states), §5.2
- `conformance/parity/`, every `parity.json`

## Scope

**In:**

- The fixture files at the planned path, one case per component × state, including presentation present and absent.
- A runner contract (input shape, expected output) each core implements.
- `features.json` rows and allowed N/As; every SDK manifest at `planned` with its UK item named.

**Out** (and where it belongs instead):

- The runners in each core (→ UK-03, UK-07, UK-09, UK-11, UK-12).
- `ui.cli` and the `headless` N/A removal (→ SP-00, already done).

## Design notes

- No server or wire change.
- Fixture inputs reuse existing SDK result shapes, so no new types enter `shared-protocol`.

## Steps

1. Confirm `plans/UK-02.md` is approved (merged).
2. Implement exactly the plan, in its order.
3. Run the gates in the header.

## Acceptance criteria

- [ ] `pnpm parity:check -- --check` passes with every new id `planned` in every SDK.
- [ ] Every §4.1 must component has at least one fixture per listed state.
- [ ] The green gate passes (AGENTS.md), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm parity:check -- --check
mise exec node@22 -- pnpm gen:constants -- --check
```

## Hand-off

Each core runs these fixtures in its own suite; UK-15 renders every fixture state in every kit for the report.

The role agent sets `--set UK-02b in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-02b done`.
