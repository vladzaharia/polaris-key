# DOC-12a Generators

| Field       | Value                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | DOC: Documentation: one docs site with Help, Developers and Operate (docs/research/2026-10-08-docs/) (Reference and contribute) |
| Size        | 0.6 engineer-weeks                                                                                                              |
| Depends on  | [DOC-03a](DOC-03a-skeleton-and-contracts.md), [DOC-05a](DOC-05a-help-messages.md)                                               |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [AX-10](AX-10-sdk-skills-should-tier.md)                                                |
| Role        | `pkey-implementer`                                                                                                              |
| Plan mode   | no                                                                                                                              |
| Gates       | `drift-gate`, `docs-generated`, `docs-links`                                                                                    |
| Human input | none                                                                                                                            |
| Repo        | `vladzaharia/polaris-key`                                                                                                       |

## Goal

The pages and parts below ship and meet the docs plan's common definition of done (§6.3) and this package's own checks.

## Why

The owner asked for "first class documentation, thorough but not overly so" on one site that also serves consumers and looks like part of Polaris Key. [The docs plan](../../../2026-10-08-docs/README.md) (2026-10-08) splits the work into 28 packages; this is its row DOC-12a (§6.1).

## Read first

- `AGENTS.md` (always), and [the docs plan](../../../2026-10-08-docs/README.md): §1, §2, §6.1 (this row), §6.3 and the sections the scope names.
- [`style-guide.md`](../../../2026-10-08-docs/style-guide.md): the only home for writing rules.

## Scope

**In:** Error codes (the Help column after DOC-05a); CLI; GitHub Action; the changelog collection and views with `replaces`; **Upgrade to 0.9** and its table; compatibility; validation codes, settings, parity, routes and config entry kept current; the removed-names lint (on at SP-35)

**Out** (and where it belongs instead):

- Pages and parts other DOC packages own (§6.1); P2 pages, written in the PR of the consolidation package that ships the behaviour (§10).

## Sources of truth

`scripts/gen-reference.mjs`; `conformance/parity/{errors,copy.en}.json`; OpenAPI; `help.ts`; `action.yml`; AGENTS.md rule 3; the P0-42 and SP-37 scopes

## Design notes

- The error-code Help column waits for DOC-05a's message map; the rest does not. The developer changelog generator lives here, so v0.9.0 ships its break list (§10 amendment 5).
- Nothing describes unbuilt behaviour as shipped; P2 lines belong to the consolidation packages that ship them (§10).

## Steps

1. Verify this brief against the code and the docs site (the code is the fact) and record any correction here, in the same branch.
2. Write or build the scope against DOC-03a's contracts; run the docs tests while working and the scoped gate once at hand-off.

## Acceptance criteria

- [ ] The common definition of done in the docs plan §6.3 holds.
- [ ] Every new generator has `--check` and a byte-compare test.
- [ ] `pkey-wp-reviewer` passes the package.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/docs build
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
mise exec node@22 -- pnpm --filter @polaris-key/docs test
mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
```

## Hand-off

The role agent sets `--set DOC-12a in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set DOC-12a done`.
