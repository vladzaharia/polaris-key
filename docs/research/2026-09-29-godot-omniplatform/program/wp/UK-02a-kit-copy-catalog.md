# UK-02a Kit copy catalog: `packages/brand/kit-copy/` ICU catalog over `core.copy`, per-platform generators and the eight launch locale packs

| Field       | Value                                                                                                                                                                                                                                                                                                                         |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (must)                                                                                                                                                                                                                                                  |
| Size        | 1.5–2.5 engineer-weeks                                                                                                                                                                                                                                                                                                        |
| Depends on  | [UK-02](UK-02-copy-fixtures-parity-plan.md), [SP-00](SP-00-parity-registry-plan.md)                                                                                                                                                                                                                                           |
| Unblocks    | [UK-03](UK-03-ui-core.md), [UK-04](UK-04-web-components.md), [UK-05](UK-05-react-kit.md), [UK-07](UK-07-swiftui-ios.md), [UK-09](UK-09-compose-android.md), [UK-11](UK-11-godot-kit.md), [UK-12](UK-12-python-qt.md), [UK-13](UK-13-python-terminal.md), [UK-14](UK-14-node-terminal.md), [UK-15](UK-15-visual-qa-harness.md) |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                                                                                                                                                         |
| Plan mode   | yes: executes the approved [`plans/UK-02.md`](../plans/UK-02.md)                                                                                                                                                                                                                                                              |
| Gates       | plan mode (executes `plans/UK-02.md`); the generator's `--check` drift gate; rule 3 banners; every SDK suite's generated-file test                                                                                                                                                                                            |
| Human input | none                                                                                                                                                                                                                                                                                                                          |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                     |

## Owner decision (2026-10-05): licence choice at sign-in

The owner decided on 2026-10-05 that every sign-in that binds a device asks the person which licence to use (**Choose a licence for this device**, with an inline **Replace a device** on full licences), never silently mints a second auto-issued licence, and treats the rank-first rule as the preselected default only. The verbatim decision, the card API and the delegated decisions are in [`plans/I-04.md`](../plans/I-04.md), "Owner decision (2026-10-05): licence choice at sign-in"; that section wins over this brief where they differ. **The device wire does not change** (`PROTOCOL_VERSION` 4, no corpus change).

For this package: **add the copy keys** for the renamed device-limit screen:

- `deviceLimit.title`: "Replace a device";
- `deviceLimit.primary`: "Replace {device}";
- `deviceLimit.consequence`: "{device} will need to sign in again";
- `deviceLimit.confirm`: "Replace {device}? It will need to sign in again.".

They replace "Remove <device> and continue". The hosted card's `LicenseChoiceStep` copy lives in
the portal, not in this catalog.

## Goal

One ICU catalog holds every kit string, every SDK gets its generated catalog in the launch locales, and the drift gate fails on a hand edit.

## Why

Copy drift between kits was a root cause in critique round 1, and every audit found hard-coded strings outside the copy bags (§4.7). The spec is [`docs/design/UI-KITS.md`](../../../../design/UI-KITS.md); its "Owner decisions (2026-10-05)" header wins over the sections below it.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode).
- `plans/UK-02.md` (approved)
- [UI-KITS.md](../../../../design/UI-KITS.md) §4.7, §1.5 rule 11 (copy rules)
- Today's copy bags: React `theme.ts`, Swift `PolarisCopy`, Kotlin `strings.xml`, Godot `pkey_ui_copy.gd`

## Scope

**In:**

- `kit-copy/en.json` with every key the plan lists; references to `core.copy` keys instead of duplicates.
- Generators for every platform format the plan names, with GENERATED banners.
- The eight non-English packs, glossary-driven, marked `reviewed: false`.
- Plural and select via ICU; platform words ("this iPhone", "this Mac") as selects.

**Out** (and where it belongs instead):

- Kits switching to the catalog (→ each kit).
- The string lint (→ UK-15).

## Design notes

- Translations are produced in this package and reviewed by a native speaker later (lead decision, 2026-10-05); that review is not a merge blocker.
- CJK packs must not introduce line-break opportunities inside keys or user codes.

## Steps

1. Confirm `plans/UK-02.md` is approved (merged).
2. Implement exactly the plan, in its order.
3. Run the gates in the header.

## Acceptance criteria

- [ ] Every key has a value in all nine locales; a missing key fails the generator.
- [ ] The generator's `--check` mode is in the green gate and passes.
- [ ] The green gate passes (AGENTS.md), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm gen:brand -- --check
mise exec node@22 -- pnpm gen:constants -- --check
```

## Hand-off

Kits read only generated catalogs. UK-15's string lint diffs visible strings against these keys.

The role agent sets `--set UK-02a in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-02a done`.
