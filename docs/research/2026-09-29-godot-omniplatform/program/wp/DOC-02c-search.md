# DOC-02c Search

| Field       | Value                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------ |
| Phase       | DOC: Documentation: one docs site with Help, Developers and Operate (docs/research/2026-10-08-docs/) (site design) |
| Size        | 0.3–0.4 engineer-weeks                                                                                             |
| Depends on  | [DOC-02a](DOC-02a-shared-components.md), [DOC-03b](DOC-03b-public-access.md)                                       |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                             |
| Role        | `pkey-implementer`                                                                                                 |
| Plan mode   | no                                                                                                                 |
| Gates       | `docs-generated`, `docs-links`                                                                                     |
| Human input | none                                                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                                                          |

## Owner decision (2026-10-08): public developer docs

The developer sections (`start/`, `build/`, `features/`, `reference/`) are public (owner decision, 2026-10-08; [docs plan](../../../2026-10-08-docs/README.md) D2). Operate → Console stays member-only; Operate → Platform, Contribute and the runbook stay admin-only. Where the text below assumes members-only developer pages, this wins.

- The public bundles (Help, Developers) load without a session, and "Search all docs" shows to everyone; only the member and admin bundles are fetched behind their gates.

## Goal

The pages and parts below ship and meet the docs plan's common definition of done (§6.3) and this package's own checks.

## Why

The owner asked for "first class documentation, thorough but not overly so" on one site that also serves consumers and looks like part of Polaris Key. [The docs plan](../../../2026-10-08-docs/README.md) (2026-10-08) splits the work into 28 packages; this is its row DOC-02c (§6.1).

## Read first

- `AGENTS.md` (always), and [the docs plan](../../../2026-10-08-docs/README.md): §1, §2, §6.1 (this row), §6.3 and the sections the scope names.

## Scope

**In:** The ⌘K dialog on the Pagefind JS API: merged tier bundles, grouped by door, `?q=`, code jump, Help-only default

**Out** (and where it belongs instead):

- Pages and parts other DOC packages own (§6.1); P2 pages, written in the PR of the consolidation package that ships the behaviour (§10).

## Sources of truth

console `CommandPalette`; DOC-03b's bundles

## Design notes

- Nothing describes unbuilt behaviour as shipped; P2 lines belong to the consolidation packages that ship them (§10).

## Steps

1. Verify this brief against the code and the docs site (the code is the fact) and record any correction here, in the same branch.
2. Write or build the scope against DOC-03a's contracts; run the docs tests while working and the scoped gate once at hand-off.

## Acceptance criteria

- [ ] The common definition of done in the docs plan §6.3 holds.
- [ ] Keyboard-only test.
- [ ] A gated bundle is never fetched without a session.
- [ ] `pkey-ux-reviewer` passes the rendered pages in built mode, both themes and phone (§6.3).
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

The role agent sets `--set DOC-02c in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set DOC-02c done`.
