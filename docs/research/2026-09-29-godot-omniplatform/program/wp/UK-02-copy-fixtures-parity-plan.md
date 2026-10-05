# UK-02 Plan: UI kit copy catalog beside `core.copy`, conformance UI state fixtures and `ui.*` parity rows

| Field       | Value                                                                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (must)                                                                                                    |
| Size        | 0.4–0.6 engineer-weeks                                                                                                                                                          |
| Depends on  | none                                                                                                                                                                            |
| Unblocks    | [UK-02a](UK-02a-kit-copy-catalog.md), [UK-02b](UK-02b-ui-fixtures-parity.md)                                                                                                    |
| Role        | `pkey-wire-planner` (planning only)                                                                                                                                             |
| Plan mode   | yes: this package writes `plans/UK-02.md`; no code before a human approves it                                                                                                   |
| Gates       | plan mode (CLAUDE.md): names `gen:constants -- --check`, `gen:corpus -- --check`, `parity:check -- --check` and the generated parity docs page for the packages that execute it |
| Human input | none                                                                                                                                                                            |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                       |

## Goal

`plans/UK-02.md` fixes the kit copy catalog, the UI state fixtures and the `ui.*` parity rows exactly enough that UK-02a and UK-02b can implement them without further decisions, and it is approved by a human.

## Why

The catalog is generated into every SDK, the fixtures are shared conformance data, and the parity rows change every SDK's manifest: an all-languages event that CLAUDE.md puts through plan mode. SP-00 already introduces `conformance/parity/copy.en.json` (`core.copy`) and `ui.cli`; this plan must sit on top of it, not beside it. The spec is [`docs/design/UI-KITS.md`](../../../../design/UI-KITS.md); its "Owner decisions (2026-10-05)" header wins over the sections below it.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode).
- [UI-KITS.md](../../../../design/UI-KITS.md) §4.6, §4.7 (the catalog, its generators, the launch locales, the string lint), §5.2 (fixtures and parity)
- `plans/SP-00.md` (or the SP-00 brief if its plan is not yet written) and `notes/SDK-PARITY-PASS.md` §3.2
- `conformance/parity/features.json`, every `parity.json`, `tools/gen-sdk-constants*`

## Scope

**In:**

- The catalog: `packages/brand/kit-copy/en.json` (ICU MessageFormat, ~220 keys) and its relationship to `copy.en.json`: kit strings reference `core.copy` keys by name; no key exists in both. Key naming, platform variants (verb and casing only), plural and select rules.
- The generators and their outputs: JSON (web), `Localizable.xcstrings` (Swift), Compose Resources `strings.xml` (Kotlin), gettext `.po`/`.pot` (Godot, Python), Qt Linguist from the same source, terminal tables; which tool owns them (`gen:brand` or `gen:constants`) and their drift gate.
- Launch locales `de`, `fr`, `es`, `pt-BR`, `it`, `ja`, `ko`, `zh-Hans`, with `reviewed: false` metadata; no RTL locale.
- The UI fixture format and path (the spec proposes `conformance/corpus/v2/ui/`; the plan confirms or moves it, since these are unsigned fixtures and not corpus cases): inputs (license status, capabilities, decision, device list, error code, presentation present or absent) → component, state, copy keys.
- Parity rows `ui.gate`, `ui.activate`, `ui.signin`, `ui.deviceLimit`, `ui.devices`, `ui.update`, `ui.settings`, `ui.paywall`, `ui.theme`, `ui.i18n` with allowed N/As, and each SDK's starting manifest state (`planned`, UK item named).

**Out** (and where it belongs instead):

- Implementation (→ UK-02a catalog, UK-02b fixtures and parity).
- `core.copy`, `ui.cli` and `copy.en.json` themselves (→ SP-00).

## Design notes

- No wire change and no `PROTOCOL_VERSION` bump: the fixtures' inputs are existing SDK results.
- The plan names every SDK that follows: React/client-core, Node, Python, Swift, Kotlin, Godot.

## Steps

1. Read `plans/README.md` and write `plans/UK-02.md`.
2. `node check.mjs --set UK-02 awaiting-approval`; open the plan PR and stop.

## Acceptance criteria

- [ ] `plans/UK-02.md` exists with every required section of `plans/README.md`, names every file, generator, gate and SDK, and is set to `awaiting-approval`.
- [ ] The green gate passes (AGENTS.md), including every drift gate listed in the header.

## Verify

```sh
node docs/research/2026-09-29-godot-omniplatform/program/check.mjs
```

## Hand-off

UK-02a and UK-02b execute exactly the approved plan.

The role agent sets `--set UK-02 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-02 done`.
