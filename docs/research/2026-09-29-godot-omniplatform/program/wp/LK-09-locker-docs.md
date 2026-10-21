# LK-09 Docs: Help door words and host (D7), the 26 developer pages, a badges page

| Field       | Value                                                                        |
| ----------- | ---------------------------------------------------------------------------- |
| Phase       | LK: Polaris Locker                                                           |
| Size        | 0.25–0.5 engineer-weeks                                                      |
| Depends on  | [LK-02](LK-02-locker-words-and-docs.md), [DOC-03b](DOC-03b-public-access.md) |
| Unblocks    | none                                                                         |
| Role        | `pkey-implementer`                                                           |
| Plan mode   | no                                                                           |
| Gates       | docs-links, docs-generated, drift-gate                                       |
| Human input | none                                                                         |
| Repo        | `vladzaharia/polaris-key`                                                    |

## Goal

Docs: Help door words and host (D7), the 26 developer pages, a badges page. Executes `plans/LK-00.md` D7, §2.3; do not restate the plan.

## Read first

- `AGENTS.md`, `CLAUDE.md`, and `plans/LK-00.md` D7, §2.3 (plus its §0, §1, A1 and A2 notes).

## Scope

Exactly `plans/LK-00.md` D7, §2.3. Anything else is another package's row in §9.

Re-scoped by Amendment A3: the Help door, the host, and a badges page for the 16 labels; see `plans/LK-00.md` §14.6.

## Acceptance criteria

- [ ] docs `lint:docs`, `check:links` pass; `drift-gate` docs-csp clean
- [ ] The relevant `plans/LK-00.md` §13 commands pass; the green gate passes (AGENTS.md).

- [ ] `/docs/help/code/<id>/` redirect pages (docs plan section 3.1 and 7.4; deferred from DOC-03b).
- [ ] `robots.txt` for the docs host: a route and an OpenAPI row (deferred from DOC-03b).
- [ ] Cacheable public HTML and public `/_astro/` (`public, immutable`; docs plan section 3.1 "Caching"; deferred from DOC-03b).
- [ ] A Polaris Locker mark for the Help header (the brand package has none; the Key mark stays beside the Locker name).
- [ ] The key.plrs.im sitemap still lists Help pages whose canonical URL is polaris.locker; give the customer host its own sitemap or drop them.

## Hand-off

The role agent sets `--set LK-09 in-review` when it hands off; the lead sets `done` after review.

## Progress and continuation

- 2026-10-19, slice 1 (words only): Help door under `packages/docs/src/content/docs/help/` says Polaris Locker (first mention) then Locker; titles changed, slugs unchanged. Owner chose a hard cutover (no switch), so on-screen strings and mail subjects also say Polaris Locker; no dual-state wording remains. Strings are the obvious Locker form; check them against the LK-06/07/08a strings when those merge.
- Remaining: (1) the host move to `polaris.locker/docs/help/` and the `what-is-polaris-locker` slug (`site-map.json` row + redirect + help-link tables), blocked on DOC-03b; (2) the badges page for the 16 labels, needs LK-12 destinations. Status stays in-progress.

- 2026-10-20: merged `integ/next` (LK-15, ST-08, DOC-03b, cutover fixes). Help quotes match the shipped mail subjects and `portalLabels`; docs build, `check:links`, `lint:docs`, docs tests pass. Still to do: the host move to `polaris.locker/docs/help/` with the `what-is-polaris-locker` slug (row, redirect, help-link tables), and the badges page (LK-12). Stays in-progress.

- 2026-10-20, slice 2 (host move): Help is served on polaris.locker (`/docs/help/*` through
  `handleDocs`, confined by `customerDocsPath`; other `/docs` 302s to key.plrs.im; `/help[/*]`
  stays on the host); key.plrs.im `/docs/help/*` 301s to it (`oldCustomerUrlRedirect`). Help pages
  say Polaris Locker (title suffix, `og:site_name`, header name, home link) and show only the Help
  sidebar (`routeData.ts`, `lib/helpHost.ts`, every door scoped). Canonical decision: a Help page's
  canonical URL and `og:url` are `https://polaris.locker/docs/help/...` (the customer's URL).
  `what-is-polaris-key` is now `what-is-polaris-locker` (`site-map.json` `extraRedirects`; the
  `nav.ts` and `docsLinks.ts` tables hold no link to it). `test/customerHelpLinks.test.ts` fetches
  the footer's Help and Privacy links and `docsLinks.downloadPage` on the customer host. Still
  open: the badges page (LK-12) and the acceptance lines above. Upstream note: three
  `helpMessages.test.ts` cases fail on integ/next because `code_expired` has no Help entry.
