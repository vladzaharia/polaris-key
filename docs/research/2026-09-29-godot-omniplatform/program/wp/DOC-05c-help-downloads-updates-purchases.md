# DOC-05c Help: downloads, updates, purchases

| Field       | Value                                                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Phase       | DOC: Documentation: one docs site with Help, Developers and Operate (docs/research/2026-10-08-docs/) (Help)                  |
| Size        | 0.3 engineer-weeks                                                                                                           |
| Depends on  | [DOC-03a](DOC-03a-skeleton-and-contracts.md)                                                                                 |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [DOC-06a](DOC-06a-portal-entry-points.md), [DOC-06b](DOC-06b-worker-entry-points.md) |
| Role        | `pkey-implementer`                                                                                                           |
| Plan mode   | no                                                                                                                           |
| Gates       | `docs-generated`, `docs-links`                                                                                               |
| Human input | none                                                                                                                         |
| Repo        | `vladzaharia/polaris-key`                                                                                                    |

## Goal

The pages and parts below ship and meet the docs plan's common definition of done (§6.3) and this package's own checks.

## Why

The owner asked for "first class documentation, thorough but not overly so" on one site that also serves consumers and looks like part of Polaris Key. [The docs plan](../../../2026-10-08-docs/README.md) (2026-10-08) splits the work into 28 packages; this is its row DOC-05c (§6.1).

## Read first

- `AGENTS.md` (always), and [the docs plan](../../../2026-10-08-docs/README.md): §1, §2, §6.1 (this row), §6.3 and the sections the scope names.
- [`style-guide.md`](../../../2026-10-08-docs/style-guide.md): the only home for writing rules.

## Scope

**In:** `download`, `check-a-download`, `install-sources`, `update`, `restore-purchase`, `refunds`

**Out** (and where it belongs instead):

- Pages and parts other DOC packages own (§6.1); P2 pages, written in the PR of the consolidation package that ships the behaviour (§10).

## Sources of truth

`portal/downloads.ts`; `distribution/page/render.ts`; store origins; the kits' update screens

## Design notes

- Nothing describes unbuilt behaviour as shipped; P2 lines belong to the consolidation packages that ship them (§10).

## Steps

1. Verify this brief against the code and the docs site (the code is the fact) and record any correction here, in the same branch.
2. Write or build the scope against DOC-03a's contracts; run the docs tests while working and the scoped gate once at hand-off.

## Acceptance criteria

- [ ] The common definition of done in the docs plan §6.3 holds.
- [ ] As DOC-05b.
- [ ] `pkey-ux-reviewer` passes the rendered pages in built mode, both themes and phone (§6.3).
- [ ] A plain-language critic (a fresh subagent with no repo context, reading as someone who never chose Polaris Key) finds nothing blocking, citing `page#anchor` for each finding (§6.3).
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

The role agent sets `--set DOC-05c in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set DOC-05c done`.
