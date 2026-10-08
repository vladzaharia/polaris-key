# DOC-02b Chrome

| Field       | Value                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------ |
| Phase       | DOC: Documentation: one docs site with Help, Developers and Operate (docs/research/2026-10-08-docs/) (site design) |
| Size        | 0.4–0.6 engineer-weeks                                                                                             |
| Depends on  | [DOC-01](DOC-01-docs-mockups.md), [DOC-02a](DOC-02a-shared-components.md)                                          |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                             |
| Role        | `pkey-implementer`                                                                                                 |
| Plan mode   | no                                                                                                                 |
| Gates       | `docs-generated`, `docs-links`, `ui-snapshots`                                                                     |
| Human input | none                                                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                                                          |

## Owner decision (2026-10-08): public developer docs

The developer sections (`start/`, `build/`, `features/`, `reference/`) are public (owner decision, 2026-10-08; [docs plan](../../../2026-10-08-docs/README.md) D2). Operate → Console stays member-only; Operate → Platform, Contribute and the runbook stay admin-only. Where the text below assumes members-only developer pages, this wins.

- The Help footer's "Building an app? Developer docs" link and the landing's Developers card carry no "For console members" label; the Operate card keeps it.

## Goal

The pages and parts below ship and meet the docs plan's common definition of done (§6.3) and this package's own checks.

## Why

The owner asked for "first class documentation, thorough but not overly so" on one site that also serves consumers and looks like part of Polaris Key. [The docs plan](../../../2026-10-08-docs/README.md) (2026-10-08) splits the work into 28 packages; this is its row DOC-02b (§6.1).

## Read first

- `AGENTS.md` (always), and [the docs plan](../../../2026-10-08-docs/README.md): §1, §2, §6.1 (this row), §6.3 and the sections the scope names.

## Scope

**In:** §8.3's overrides: header, door sidebars and the collapse rule, footer, pager, theme key and motion, phone menu, ToC, 404, `Landing.astro`, Help density

**Out** (and where it belongs instead):

- Pages and parts other DOC packages own (§6.1); P2 pages, written in the PR of the consolidation package that ships the behaviour (§10).

## Sources of truth

approved DOC-01 mockups; `PortalShell.tsx`; console `Sidebar`; `components/theme.tsx`

## Design notes

- Builds on the reviewed DOC-01 mockups. Owns the landing layout component (`Landing.astro`); DOC-07a owns its copy.
- Nothing describes unbuilt behaviour as shipped; P2 lines belong to the consolidation packages that ship them (§10).

## Steps

1. Verify this brief against the code and the docs site (the code is the fact) and record any correction here, in the same branch.
2. Write or build the scope against DOC-03a's contracts; run the docs tests while working and the scoped gate once at hand-off.

## Acceptance criteria

- [ ] The common definition of done in the docs plan §6.3 holds.
- [ ] No horizontal scroll at 390 px.
- [ ] Built shots beside the console and portal baselines (§8.5).
- [ ] `pnpm ui:lint --html` on the built pages.
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

The role agent sets `--set DOC-02b in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set DOC-02b done`.
