# DOC-03b Public access

| Field       | Value                                                                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | DOC: Documentation: one docs site with Help, Developers and Operate (docs/research/2026-10-08-docs/) (skeleton and access)                                 |
| Size        | 0.4–0.6 engineer-weeks                                                                                                                                     |
| Depends on  | [DOC-03a](DOC-03a-skeleton-and-contracts.md)                                                                                                               |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [DOC-02c](DOC-02c-search.md), [DOC-06a](DOC-06a-portal-entry-points.md), [DOC-06b](DOC-06b-worker-entry-points.md) |
| Role        | `pkey-implementer`                                                                                                                                         |
| Plan mode   | no                                                                                                                                                         |
| Gates       | `rule-9`, `rule-10`, `threat-model`, `docs-generated`, `docs-links`                                                                                        |
| Human input | D4: the Polaris Key support and privacy addresses in docs/legal/help.md, before the public switch (owner step; docs plan §0)                               |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                  |

## Owner decision (2026-10-08): public developer docs

The developer sections (`start/`, `build/`, `features/`, `reference/`) are public (owner decision, 2026-10-08; [docs plan](../../../2026-10-08-docs/README.md) D2). Operate → Console stays member-only; Operate → Platform, Contribute and the runbook stay admin-only. Where the text below assumes members-only developer pages, this wins.

- The access page catches only Operate pages.
- Pagefind bundles: `help` and `developers` are public; `member` and `admin` stay behind their gates.
- The tier rule: Help and Developers pages link only to public pages; the chrome exception covers only the landing's Operate card, labelled "For console members".
- Developer pages are indexable and in the sitemap; gated pages keep `noindex`.
- `llms.txt` for Help and the developer door is now possible (§3.9, P3); it is not in this package.

## Goal

The pages and parts below ship and meet the docs plan's common definition of done (§6.3) and this package's own checks.

## Why

The owner asked for "first class documentation, thorough but not overly so" on one site that also serves consumers and looks like part of Polaris Key. [The docs plan](../../../2026-10-08-docs/README.md) (2026-10-08) splits the work into 28 packages; this is its row DOC-03b (§6.1).

## Read first

- `AGENTS.md` (always), and [the docs plan](../../../2026-10-08-docs/README.md): §1, §2, §6.1 (this row), §6.3 and the sections the scope names.

## Scope

**In:** `docs-access.json` with asset tiers; the tiered gate; `/docs/access/`; three Pagefind bundles; the `/help` alias (OpenAPI row, `routeCoverage`); `/docs/help/code/<id>/`; `help` reserved (D8); sitemap, robots, `noindex`; the tier rule and its chrome exception in `check:links`; a THREAT-MODEL row; rule 11 and C-51 text

**Out** (and where it belongs instead):

- Pages and parts other DOC packages own (§6.1); P2 pages, written in the PR of the consolidation package that ships the behaviour (§10).

## Sources of truth

`packages/worker/src/docs.ts`, the router, OpenAPI; `shared-manifest/src/productSlug.ts`, `product.schema.json`; the ST-29 and ST-35 scopes

## Design notes

- Build the tiered gate and the bundles at once. The **public switch** (Help served without a session) waits for D4 and for DOC-04a, DOC-04b, DOC-05a, DOC-05b and DOC-05c to have no stubs; the package is done when the switch is on.
- Nothing describes unbuilt behaviour as shipped; P2 lines belong to the consolidation packages that ship them (§10).

## Steps

1. Verify this brief against the code and the docs site (the code is the fact) and record any correction here, in the same branch.
2. Write or build the scope against DOC-03a's contracts; run the docs tests while working and the scoped gate once at hand-off.

## Acceptance criteria

- [ ] The common definition of done in the docs plan §6.3 holds.
- [ ] Worker tests: Help returns 200 with no session.
- [ ] A member page sends a sessionless reader to `/docs/access/`.
- [ ] Gated bundles and gated-only assets are refused.
- [ ] The reserved-slug test row.
- [ ] `gen:check` for the schema copy.
- [ ] The lead's check that no product uses `help`.
- [ ] A security review before merge.
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

The role agent sets `--set DOC-03b in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set DOC-03b done`.
