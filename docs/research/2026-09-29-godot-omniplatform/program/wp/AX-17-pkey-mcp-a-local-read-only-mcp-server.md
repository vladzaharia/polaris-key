# AX-17 `pkey mcp`: a local, read-only MCP server

| Field       | Value                                                                                                                                                                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | AX: Agent experience: READMEs, llms files, skills, a CLI machines can drive and an eval harness (docs/research/2026-10-08-llm-audit/) (LLM audit (2026-10-08))                                                                                       |
| Size        | 1.2–1.6 engineer-weeks                                                                                                                                                                                                                               |
| Depends on  | [AX-06](AX-06-markdown-twins-llms-files-agent-kit-and-schemas.md), [AX-07](AX-07-the-agent-kit-layout-release-zip-references-lint.md), [AX-16](AX-16-the-cli-for-agents-json-codes-pkey-explain.md), [SP-35](SP-35-sdk-api-registry-api-json-0-9.md) |
| Unblocks    | [AX-18](AX-18-public-mcp-and-skills-index-on-key-plrs-im.md), [AX-19](AX-19-operator-reads-pkey-product-status-and-two-mcp-tools.md)                                                                                                                 |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                   |
| Plan mode   | no                                                                                                                                                                                                                                                   |
| Gates       | `threat-model`                                                                                                                                                                                                                                       |
| Human input | none                                                                                                                                                                                                                                                 |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                            |

## Goal

`pkey mcp` starts a local, stdio, read-only MCP server with nine tools answering for the installed version from a prebuilt knowledge bundle.

## Why

It adds what files cannot: search, a validator and code explanations an agent can call with nothing else installed; `get_doc` returns raw Markdown to the main model where a fetch tool returns a summary. Everything it returns also exists as a `.md` page or a CLI command. Registered from [the LLM audit plan](../../../2026-10-08-llm-audit/README.md) (§6, §8.3).

## Read first

- `AGENTS.md` (always).
- [The LLM audit plan](../../../2026-10-08-llm-audit/README.md): §6, §8.3, and §2 (principles), §9 (how it fits the other plans), §10 (decisions).
- The docs [style guide](../../../2026-10-08-docs/style-guide.md) governs READMEs and skills.

## Scope

**In:**

- The server in `@polaris-key/agent-kit/mcp`, loaded lazily by `pkey mcp` at the CLI's exact version, outside the esbuild bundle; `pkey mcp` is a command in P0-45's registry.
- The knowledge bundle built with the kit: public twins, `api.json`, `errors.json`, validation and reason codes, schemas, the command registry; search is a prebuilt lexical index (no embeddings, no network).
- Tools (plan §6.3): `search_docs`, `get_doc`, `get_sdk_api`, `check_sdk_names`, `explain_code`, `get_manifest_schema`, `validate_manifest` (a local path must sit inside the client's MCP roots, the working directory when none), `get_cli_command`, `check_product`. All `readOnlyHint: true`, fixed order, `format` of `concise` or `detailed`; errors are `isError` results naming the fix; tenant-written text comes back delimited and labelled as data.
- Tests: unit tests per tool on fixtures; a snapshot of the tool list; a stdio smoke test through the MCP Inspector CLI in CI; the gated-page fixture against the index; the MCP arm of the evals (A3).

**Out** (and where it belongs instead):

- Any write tool: none in this plan (never through MCP: secrets, keys, licenses, store credentials, prices, refunds, members, deploys).
- The remote path (→ AX-18); operator reads (→ AX-19).

## Design notes

- Tier: should (optional). Wave 4 in the plan's order (§8.4). Model routing (§8.5): Sonnet 5.5; tool descriptions Opus 5.5; security review Sonnet 5.5; set the model on every agent call, never inherit.
- Security review on Sonnet 5.5; tool descriptions are judgement work (Opus 5.5).

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] The tool-list snapshot.
- [ ] The Inspector smoke test.
- [ ] The gated-page fixture.
- [ ] A test that a path outside the roots is refused.
- [ ] A security review.
- [ ] Its eval report (plan §7.4) is attached to the hand-off: the suite and arms it should move, and the measured difference with its interval. It never blocks the merge.
- [ ] `pkey-wp-reviewer` passes the package.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

`pkey agents --mcp` writes its config (AX-08); AX-18 and AX-19 reuse the tool module.

The role agent sets `--set AX-17 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set AX-17 done`.
