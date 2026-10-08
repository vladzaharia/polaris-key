# DOC-02a Shared components

| Field       | Value                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------ |
| Phase       | DOC: Documentation: one docs site with Help, Developers and Operate (docs/research/2026-10-08-docs/) (site design) |
| Size        | 0.4–0.6 engineer-weeks                                                                                             |
| Depends on  | [DOC-03a](DOC-03a-skeleton-and-contracts.md)                                                                       |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [DOC-02b](DOC-02b-chrome.md), [DOC-02c](DOC-02c-search.md)                 |
| Role        | `pkey-implementer`                                                                                                 |
| Plan mode   | no                                                                                                                 |
| Gates       | `human-approval`, `docs-generated`, `docs-links`, `ui-snapshots`                                                   |
| Human input | the lead approves the components.md §7 and BRAND.md §2 lines (D7, plan mode)                                       |
| Repo        | `vladzaharia/polaris-key`                                                                                          |

## Goal

The pages and parts below ship and meet the docs plan's common definition of done (§6.3) and this package's own checks.

## Why

The owner asked for "first class documentation, thorough but not overly so" on one site that also serves consumers and looks like part of Polaris Key. [The docs plan](../../../2026-10-08-docs/README.md) (2026-10-08) splits the work into 28 packages; this is its row DOC-02a (§6.1).

## Read first

- `AGENTS.md` (always), and [the docs plan](../../../2026-10-08-docs/README.md): §1, §2, §6.1 (this row), §6.3 and the sections the scope names.

## Scope

**In:** §8.2: `ui/theme.css` split out of the console's `styles.css`; `@astrojs/react` renders the static components; `ui/classes.ts` constants; Expressive Code themes and frame; the table wrapper; DOC-03a's MDX components restyled on these; components.md §7 and the BRAND.md §2 line

**Out** (and where it belongs instead):

- Pages and parts other DOC packages own (§6.1); P2 pages, written in the PR of the consolidation package that ships the behaviour (§10).

## Sources of truth

`packages/admin/src/{styles.css,ui/*,lib/highlight.ts}`; `packages/brand/css/*`, `tokens.json`; components.md; EXPERIENCE.md §3

## Design notes

- D7: the docs render the console's own `ui/` components at build time and share class constants for interactive parts; no new brand stylesheet, and the mockup kit is not extracted (§8.2). DOC-03a's MDX components keep their props; this package only restyles them.
- Nothing describes unbuilt behaviour as shipped; P2 lines belong to the consolidation packages that ship them (§10).

## Steps

1. Verify this brief against the code and the docs site (the code is the fact) and record any correction here, in the same branch.
2. Write or build the scope against DOC-03a's contracts; run the docs tests while working and the scoped gate once at hand-off.

## Acceptance criteria

- [ ] The common definition of done in the docs plan §6.3 holds.
- [ ] Console and portal baselines unchanged (the split is a pure move).
- [ ] A test renders each listed component in the docs build.
- [ ] `docs-classes.test.ts` (§8.5).
- [ ] Syntax-role contrast ≥ 4.5:1 on the code ground.
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

The role agent sets `--set DOC-02a in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set DOC-02a done`.
