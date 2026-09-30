# <ID> <Title, identical to workpackages.json>

| Field       | Value                                                                    |
| ----------- | ------------------------------------------------------------------------ |
| Phase       | <phase id>: <phase title> (<stage, if any>)                              |
| Size        | <min–max> engineer-weeks                                                 |
| Depends on  | <ids, linked to their briefs, or "none">                                 |
| Unblocks    | <ids that list this one as a dependency>                                 |
| Role        | `<role from workpackages.json>` (see `.claude/agents/`)                  |
| Plan mode   | <yes: the plan needs human approval before code / no>                    |
| Gates       | <drift gates and rules this touches: rule 9, rule 10, corpus, migration> |
| Human input | <accounts, keys, devices or decisions a person must supply, or "none">   |
| Repo        | <`vladzaharia/polaris-key` or `vladzaharia/diceroll`>                    |

## Goal

One paragraph: the outcome, stated so a reviewer can tell whether it happened.

## Why

Two to five sentences: the problem this fixes or the capability it adds, with links to the
report sections, issues or notes that establish it (e.g. `../../README.md#91-polaris-key-worth-fixing-regardless-of-godot`
issue #6).

## Read first

- `AGENTS.md` (always) and the skill that applies, if any.
- The report sections and notes that define this work, as relative links.
- The code it changes, as repo-relative paths with line anchors where they help.

## Scope

**In:**

- …

**Out** (and where it belongs instead):

- … (→ `<ID>`)

## Design notes

Decisions already made by the research, constraints, and the pitfalls a newcomer would hit. Quote
names exactly (tables, fields, routes, feature ids) so downstream work packages can rely on them.

## Steps

1. …

## Acceptance criteria

- [ ] … (each one checkable by a reviewer or a command)
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.
- [ ] `parity.json` manifests are updated for every SDK this changes (once P1b-01 has landed).

## Verify

```sh
mise exec node@22 -- pnpm <…>
```

## Hand-off

What downstream work packages rely on from this one (interfaces, names, files), and anything
deliberately left for them. Update `program/workpackages.json` status with
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set <ID> done` in the PR
that completes the work.
