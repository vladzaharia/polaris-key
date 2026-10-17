# DOC-12b Reference and contribute

| Field       | Value                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | DOC: Documentation: one docs site with Help, Developers and Operate (docs/research/2026-10-08-docs/) (Reference and contribute) |
| Size        | 0.4 engineer-weeks                                                                                                              |
| Depends on  | [DOC-03a](DOC-03a-skeleton-and-contracts.md)                                                                                    |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                                          |
| Role        | `pkey-implementer`                                                                                                              |
| Plan mode   | no                                                                                                                              |
| Gates       | `docs-generated`, `docs-links`                                                                                                  |
| Human input | none                                                                                                                            |
| Repo        | `vladzaharia/polaris-key`                                                                                                       |

## LLM audit (2026-10-08)

The [LLM audit plan](../../../2026-10-08-llm-audit/README.md) §9 changes this package. Where it differs from the text below, it wins.

- `contribute/agents/*` (admin tier) drops "Why there is no llms.txt" and the restated rules, and links `AGENTS.md` and the skills instead.

## Goal

The pages and parts below ship and meet the docs plan's common definition of done (§6.3) and this package's own checks.

## Why

The owner asked for "first class documentation, thorough but not overly so" on one site that also serves consumers and looks like part of Polaris Key. [The docs plan](../../../2026-10-08-docs/README.md) (2026-10-08) splits the work into 28 packages; this is its row DOC-12b (§6.1).

## Read first

- `AGENTS.md` (always), and [the docs plan](../../../2026-10-08-docs/README.md): §1, §2, §6.1 (this row), §6.3 and the sections the scope names.
- [`style-guide.md`](../../../2026-10-08-docs/style-guide.md): the only home for writing rules.

## Scope

**In:** `reference/index`, `http-api`, `protocol/*`, `what-apps-collect`; `contribute/**` (architecture, service-model internals, release truth store, data model, corpus, agents, setup with the seed SQL); `writing-docs`

**Out** (and where it belongs instead):

- Pages and parts other DOC packages own (§6.1); P2 pages, written in the PR of the consolidation package that ships the behaviour (§10).

## Sources of truth

the moved pages' sources; WIRE-CONTRACT-V4; `shared-protocol/src/core.ts`

## Design notes

- Nothing describes unbuilt behaviour as shipped; P2 lines belong to the consolidation packages that ship them (§10).

## Steps

1. Verify this brief against the code and the docs site (the code is the fact) and record any correction here, in the same branch.
2. Write or build the scope against DOC-03a's contracts; run the docs tests while working and the scoped gate once at hand-off.

## Acceptance criteria

- [x] The common definition of done in the docs plan §6.3 holds.
- [x] Protocol pages point at V4.
- [ ] `pkey-wp-reviewer` passes the package.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Corrections and notes (2026-10-16)

- DOC-03a's site map had already moved every page in scope; this package typed them, cleared their lint debt, and wrote the two stubs: `contribute/service-model` (from the old `start/service-model`, corrected to the code: the `registration` key is retired and never written) and `contribute/writing-docs` (renders `docs/research/2026-10-08-docs/style-guide.md`; its one relative link became a code span so it doesn't break on the site).
- The protocol pages cite WIRE-CONTRACT-V4, whose section numbers match the sections they cited in V3 (§2.2, §5.1, §5.2, §6.1, §10). `build/wire/index` is now **The protocol**; "a fifth SDK" and "wire contract v3" are gone from them.
- `contribute/corpus` was 8,000 words with the add-a-case loop twice. It is split: `corpus` (what is in it, the generator, the runners, the drift gate) and a new `corpus-cases` (add a case, each hand-authored matrix, the HTTP transcripts). Programme ids and plan paths were removed from both. Case history that named a package was dropped with its id.
- `reference/http-api` is rewritten (base URL, authentication, errors, versioning, pagination); the "skeleton" and "wire contract v3" wording is gone. The OpenAPI file's own header comment still says WIRE-CONTRACT-V3; that is rule 10's file and outside this package.
- `docs/PRIVACY.md` (rendered as **What apps collect**) is corrected against the code for each REVIEW-NOTES §4 item: IP-derived geolocation (a sign-in keeps Cloudflare's city and country with the pending sign-in), `devices.ua` (the raw User-Agent, kept with the device record), Workers Logs (enabled and persisted), the `reported_json` snapshot (a deauthorized device keeps its record), "Godot today" (the heading drops it; the Node report type carries `updates`), and "disabling a license purges every device" (only deauthorizing a device purges). The `docs/legal` drafts and the portal docs page in REVIEW-NOTES §4's last bullet are not part of this package.
- The `contribute/` public-page text that DOC-08b moved out of the UI section ("Writing into this section", the component and framework page templates' prose) is not carried over: the templates carry their own header comments. Add it to `docs-components` if wanted.
- `contribute/data-model` and `reference/protocol/{corpus,fingerprint-constants}` are generated and are untouched; their frontmatter comes from `gen-reference.mjs`.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/docs build
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
mise exec node@22 -- pnpm --filter @polaris-key/docs test
mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
```

## Hand-off

The role agent sets `--set DOC-12b in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set DOC-12b done`.
