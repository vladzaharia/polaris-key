# DOC-03b Public access

| Field       | Value                                                                                                                                                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | DOC: Documentation: one docs site with Help, Developers and Operate (docs/research/2026-10-08-docs/) (skeleton and access)                                                                                                                                   |
| Size        | 0.4–0.6 engineer-weeks                                                                                                                                                                                                                                       |
| Depends on  | [DOC-03a](DOC-03a-skeleton-and-contracts.md)                                                                                                                                                                                                                 |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [DOC-02c](DOC-02c-search.md), [DOC-06a](DOC-06a-portal-entry-points.md), [DOC-06b](DOC-06b-worker-entry-points.md), [AX-06](AX-06-markdown-twins-llms-files-agent-kit-and-schemas.md), [LK-09](LK-09-locker-docs.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                           |
| Plan mode   | no                                                                                                                                                                                                                                                           |
| Gates       | `rule-9`, `rule-10`, `threat-model`, `docs-generated`, `docs-links`                                                                                                                                                                                          |
| Human input | D4: the Polaris Key support and privacy addresses in docs/legal/help.md, before the public switch (owner step; docs plan §0)                                                                                                                                 |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                    |

## Owner decision (2026-10-08): public developer docs

The developer sections (`start/`, `build/`, `features/`, `reference/`) are public (owner decision, 2026-10-08; [docs plan](../../../2026-10-08-docs/README.md) D2). Operate → Console stays member-only; Operate → Platform, Contribute and the runbook stay admin-only. Where the text below assumes members-only developer pages, this wins.

- The access page catches only Operate pages.
- Pagefind bundles: `help` and `developers` are public; `member` and `admin` stay behind their gates.
- The tier rule: Help and Developers pages link only to public pages; the chrome exception covers only the landing's Operate card, labelled "For console members".
- Developer pages are indexable and in the sitemap; gated pages keep `noindex`.
- `llms.txt` for Help and the developer door is now possible (§3.9, P3); it is not in this package.

## LLM audit (2026-10-08)

The [LLM audit plan](../../../2026-10-08-llm-audit/README.md) §9 changes this package. Where it differs from the text below, it wins.

- Two switches: the developer door (`/docs/start/`, `/build/`, `/features/`, `/reference/`) is public when DOC-03b merges, with no wait on D4; Help goes public at D4 under its no-stub condition.
- `/docs/schemas/` is a public asset tier. `/docs/agents/` (the agent kit's `marketplace.json` and zip, added by AX-06) is served with the developer door; the plan's §4.1 table lists it so, its amendment row names only the schemas (flagged at registration).
- Rule 11's new text leaves room for the `llms.txt` line (AX-03b adds it once AX-06 ships). `robots.txt` lets AI crawlers index the public docs (plan decision 11).

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

## Progress and corrections (2026-10-19)

Done: Help public (`HELP_TIER` removed; lead override of the D4 wait for the customer site);
a sessionless reader of a gated page goes to /docs/access/; three Pagefind bundles (`pagefind`,
`pagefind-member`, `pagefind-admin`; `scripts/build-search-bundles.ts`, `SEARCH_BUNDLES` in
doors.ts and docs.ts); `dist/docs-access.json`; gated pages noindex and out of the sitemap;
check:links tier rule (page content only; existing violations in `link-tier-debt.json`,
shrink-only); rule 11 and THREAT-MODEL text.

Round 2: `help` reserved as a product slug (productSlug.ts, schema, test), `/help` -> `/docs/help/` alias (router kind `helpAlias`, OpenAPI, routeCoverage); sitemap filter parses `<url>` blocks; redirect-tier test (3 known public-to-gated moves listed in searchBundles.test.ts).

Review round (2026-10-20): C-51 amended (`docs/research/2026-10-07-dx-consolidation/integration.md`);
per-file tiers built (`packages/docs/scripts/collect-docs-tiers.ts` writes
`packages/worker/src/docsTiers.generated.ts`: a file under `/_astro/` that no public page loads
takes the lowest tier among the pages that load it, and each moved-page redirect page is served at
its target's tier); sitemap files public; the access page's Sign in link carries `returnTo`;
`/help/*` aliases; a signed-in reader without the admin area gets the access page's admin wording
under a 403 (`/docs/access/admin/`); the tier rule also refuses member to admin links (existing
hits in `link-tier-debt.json`, shrink-only).

Not done, with owners:

- The search UI loads the public bundle for every reader. Owner: DOC-02c (acceptance line added).
  The bundles are nested (public in member in admin), so it must pick one bundle per tier and not
  merge them, and its "Help only" default needs a filter.
- Separate per-door search bundles (the plan's `pagefind/help` and `pagefind/developers`): the
  build has one public bundle. Owner: DOC-02c.
- `/docs/help/code/<id>/` redirect pages (plan section 3.1, 7.4). Owner: LK-09 (acceptance line).
- `robots.txt` for the docs host (a route and an OpenAPI row). Owner: LK-09 (acceptance line).
- Cacheable public HTML (plan section 3.1, "Caching"): public HTML and `/_astro/` are still
  `no-store` and `private`. Owner: LK-09 (acceptance line).
- The per-door sidebar lets the tier rule cover the chrome: `routeData.ts` now scopes the sidebar
  per door (LK-09); DOC-02b keeps the rest of the chrome.
- The host move to polaris.locker is LK-09.

## Steps

1. Verify this brief against the code and the docs site (the code is the fact) and record any correction here, in the same branch.
2. Write or build the scope against DOC-03a's contracts; run the docs tests while working and the scoped gate once at hand-off.

## Acceptance criteria

- [ ] The common definition of done in the docs plan §6.3 holds.
- [x] Worker tests: Help returns 200 with no session.
- [x] A member page sends a sessionless reader to `/docs/access/`.
- [x] Gated bundles and gated-only assets are refused (`docsTiers.generated.ts`, `docsTiersParity.test.ts`).
- [x] The reserved-slug test row.
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
