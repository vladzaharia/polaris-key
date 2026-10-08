# AX-06 Markdown twins, `llms` files, the public agent kit and schemas

| Field       | Value                                                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | AX: Agent experience: READMEs, llms files, skills, a CLI machines can drive and an eval harness (docs/research/2026-10-08-llm-audit/) (LLM audit (2026-10-08)) |
| Size        | 1.1–1.6 engineer-weeks                                                                                                                                         |
| Depends on  | [DOC-03b](DOC-03b-public-access.md), [DOC-02b](DOC-02b-chrome.md), [AX-07](AX-07-the-agent-kit-layout-release-zip-references-lint.md)                          |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [AX-17](AX-17-pkey-mcp-a-local-read-only-mcp-server.md)                                                                |
| Role        | `pkey-implementer`                                                                                                                                             |
| Plan mode   | no                                                                                                                                                             |
| Gates       | `rule-10`, `threat-model`, `docs:privacy`, `docs-generated`, `docs-links`                                                                                      |
| Human input | Submit llms.txt to Context7 once the developer docs are public (owner step; plan decision 11; the AI-crawler and robots.txt part is decided)                   |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                      |

## Goal

Every public docs page has a Markdown twin; `/llms.txt`, `/docs/llms.txt`, the per-SDK, per-feature and per-topic sets, `llms-full.txt` and Help's `llms.txt` are served within their token budgets; the agent kit and the schemas are served as public assets; `pkey init` writes the public schema URLs.

## Why

The docs are 182 pages, about 535k tokens, about 71 KB of HTML a page, with no Markdown; there is no `llms.txt`. Claude Code's WebFetch returns a small model's summary, not the text. Schemas' `$id` URLs are gated, so `pkey init` points editors at `node_modules`, which no Swift, Kotlin, Godot or Python repo has. Registered from [the LLM audit plan](../../../2026-10-08-llm-audit/README.md) (§4.1 to §4.3, §8.3).

## Read first

- `AGENTS.md` (always).
- [The LLM audit plan](../../../2026-10-08-llm-audit/README.md): §4.1 to §4.3, §8.3, and §2 (principles), §9 (how it fits the other plans), §10 (decisions).
- The docs [style guide](../../../2026-10-08-docs/style-guide.md) governs READMEs and skills.

## Scope

**In:**

- `packages/docs/scripts/gen-llms.mjs`, run inside `build` after `astro build` from the page sources and `docs-access.json`; a set map names each set's pages; outputs are build artifacts, not committed.
- Markdown twins with frontmatter (`title`, `description`, `url`, `door`, `version`); tabs flatten into labelled sections; internal links point at twins (DOC-03a's `toMarkdown` hook renders MDX components).
- Serving in `packages/worker/src/docs.ts` under `docs-access.json`: `.md` as `text/markdown; charset=utf-8`, `llms*.txt` as `text/plain; charset=utf-8`; `Accept: text/markdown` negotiation with `Vary: Accept` and `Cache-Control: private`; `Link: rel="alternate"` header and `<link>` in the head; root `/llms.txt` as a new Worker path (OpenAPI narrative row and `routeCoverage` entry, rule 10).
- The hub (plan §4.3), under 8k tokens, with the rules before code and the download-a-set instruction.
- One structured log line per `llms` file, twin, negotiated page or `/mcp` request (path class, user-agent family; no IP) in Workers Logs; no new binding; a PRIVACY.md row.
- A **Copy page** control in the page header that copies the twin. No "Open in …" buttons.
- `/docs/schemas/v1/*.json` served at their `$id` URLs; `pkey init` writes those URLs in `$schema`.
- `/docs/agents/marketplace.json` and `/docs/agents/polaris-key-<version>.zip` served as public assets (built by AX-07's tag deploy).
- Build failures proven by fixtures: hub or set over budget; a member or admin page, or text from one, reaching any `llms` file, twin, the kit's knowledge bundle or the MCP index; a public page with no twin; a link in a twin or set that does not resolve (`check:links` reads them too).

**Out** (and where it belongs instead):

- `toMarkdown` on every MDX component (→ DOC-03a).
- The kit, zip and `marketplace.json` build (→ AX-07).
- `pkey agents` and the console card (→ AX-08).
- The remote `/mcp` path (→ AX-18).
- The public switch and tiers (→ DOC-03b).

## Design notes

- Tier: must (required; gates 1.0 on its deterministic checks only). Wave 3 in the plan's order (§8.4). Model routing (§8.5): Sonnet 5.5; security review Sonnet 5.5; UX review of the Copy page control Opus 5.5; set the model on every agent call, never inherit.
- We write this generator rather than adopt `starlight-llms-txt` or Cloudflare's Markdown for Agents (decision 4): no access tiers, no per-page Markdown and no component rendering in the plugin; Cloudflare's converter works from rendered HTML.
- Nothing ships before the developer door opens (DOC-03b); until then rule 11 is true and agents read the repo. No OpenAPI file is linked: the served spec would need its 28 `/manage` paths filtered out.
- Plan §4.1 lists `/docs/agents/` and `/docs/schemas/` as public with the developer door; the DOC-03b amendment names `/docs/schemas/` as a public asset tier. Flagged at registration: AX-06 adds `/docs/agents/` to the tier map alongside it.
- Security-relevant: the tier filter. Security review on Sonnet 5.5.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Each build failure in plan §4.2 is proven by a fixture (the gated-page fixture plants a gated page and checks `llms` files, twins, the knowledge bundle and the MCP index).
- [ ] The hub is under 8k tokens; each set within its budget.
- [ ] `claude plugin marketplace add` on the deployed URL installs the plugin.
- [ ] A security review of the tier filter.
- [ ] OpenAPI row and `routeCoverage` for `/llms.txt` (rule 10); THREAT-MODEL and PRIVACY.md rows.
- [ ] Its eval report (plan §7.4) is attached to the hand-off: the suite and arms it should move, and the measured difference with its interval. It never blocks the merge.
- [ ] Any skill or README it writes or changes is reviewed against the plan's principle 9 (terse: each fact once, in the reader's words).
- [ ] `pkey-wp-reviewer` passes the package.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

AX-17 indexes the twins; AX-03b adds the `llms.txt` line to rule 11. The Context7 submission is an owner step once the docs are public.

The role agent sets `--set AX-06 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set AX-06 done`.
