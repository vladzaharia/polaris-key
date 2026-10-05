# UK-31 Optional: recipes over the elements for SolidJS, Preact, Qwik, htmx and plain pages (a Solid signals adapter only if demanded)

| Field       | Value                                                                         |
| ----------- | ----------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (could) |
| Size        | 0.5–1 engineer-weeks                                                          |
| Depends on  | [UK-04](UK-04-web-components.md)                                              |
| Unblocks    | none                                                                          |
| Role        | `pkey-implementer`                                                            |
| Plan mode   | no                                                                            |
| Gates       | docs link check                                                               |
| Human input | none                                                                          |
| Repo        | `vladzaharia/polaris-key`                                                     |

## Goal

Docs recipes show the elements in SolidJS, Preact, Qwik, htmx and plain pages, each verified by a tiny runnable example.

## Why

These are could rows of §5.1: recipes, not kits. The spec is [`docs/design/UI-KITS.md`](../../../../design/UI-KITS.md); its "Owner decisions (2026-10-05)" header wins over the sections below it.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [UI-KITS.md](../../../../design/UI-KITS.md) §5.1 could rows
- The UK-04 elements

## Scope

**In:**

- One recipe page per framework in `build/ui/` with a runnable example under `examples/ui/recipes/`.

**Out** (and where it belongs instead):

- New packages (none unless demand appears).

## Design notes

- None beyond the spec.

## Steps

1. Build the scope in the order listed.
2. Run the gates in the header.

## Acceptance criteria

- [ ] Each example renders the gate in both themes and passes `pnpm ui:lint`.
- [ ] The green gate passes (AGENTS.md).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
```

## Hand-off

None.

The role agent sets `--set UK-31 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-31 done`.
