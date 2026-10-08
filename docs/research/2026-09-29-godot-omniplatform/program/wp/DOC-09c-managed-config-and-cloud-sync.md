# DOC-09c Managed config and Cloud Sync

| Field       | Value                                                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------------------------------------- |
| Phase       | DOC: Documentation: one docs site with Help, Developers and Operate (docs/research/2026-10-08-docs/) (Developers: features) |
| Size        | 0.4 engineer-weeks                                                                                                          |
| Depends on  | [DOC-03a](DOC-03a-skeleton-and-contracts.md)                                                                                |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                                      |
| Role        | `pkey-implementer`                                                                                                          |
| Plan mode   | no                                                                                                                          |
| Gates       | `docs-generated`, `docs-links`                                                                                              |
| Human input | none                                                                                                                        |
| Repo        | `vladzaharia/polaris-key`                                                                                                   |

## Goal

The pages and parts below ship and meet the docs plan's common definition of done (§6.3) and this package's own checks.

## Why

The owner asked for "first class documentation, thorough but not overly so" on one site that also serves consumers and looks like part of Polaris Key. [The docs plan](../../../2026-10-08-docs/README.md) (2026-10-08) splits the work into 28 packages; this is its row DOC-09c (§6.1).

## Read first

- `AGENTS.md` (always), and [the docs plan](../../../2026-10-08-docs/README.md): §1, §2, §6.1 (this row), §6.3 and the sections the scope names.
- [`style-guide.md`](../../../2026-10-08-docs/style-guide.md): the only home for writing rules.

## Scope

**In:** `features/managed-config/**`: overview, add-config, catalog, edge-mint, management-states, profiles, crash-tags, troubleshooting; `features/cloud-sync/index`

**Out** (and where it belongs instead):

- Pages and parts other DOC packages own (§6.1); P2 pages, written in the PR of the consolidation package that ships the behaviour (§10).

## Sources of truth

`services/config`, `services/sync`; `shared-manifest`

## Design notes

- Nothing describes unbuilt behaviour as shipped; P2 lines belong to the consolidation packages that ship them (§10).

## Steps

1. Verify this brief against the code and the docs site (the code is the fact) and record any correction here, in the same branch.
2. Write or build the scope against DOC-03a's contracts; run the docs tests while working and the scoped gate once at hand-off.

## Acceptance criteria

- [ ] The common definition of done in the docs plan §6.3 holds.
- [ ] Cloud Sync states what works and that nothing syncs.
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

The role agent sets `--set DOC-09c in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set DOC-09c done`.
