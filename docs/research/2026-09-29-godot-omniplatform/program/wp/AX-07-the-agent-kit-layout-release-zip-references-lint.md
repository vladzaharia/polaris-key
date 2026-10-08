# AX-07 The agent kit: layout, release zip, generated references, lint

| Field       | Value                                                                                                                                                                                                                                                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | AX: Agent experience: READMEs, llms files, skills, a CLI machines can drive and an eval harness (docs/research/2026-10-08-llm-audit/) (LLM audit (2026-10-08))                                                                                                                                                                                                     |
| Size        | 1.4–1.9 engineer-weeks                                                                                                                                                                                                                                                                                                                                             |
| Depends on  | [P0-42](P0-42-generator-registry-pnpm-gen.md), [AX-03a](AX-03a-claude-md-split-move-table-role-agents.md)                                                                                                                                                                                                                                                          |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [AX-06](AX-06-markdown-twins-llms-files-agent-kit-and-schemas.md), [AX-08](AX-08-pkey-agents-product-repo-block-console-card.md), [AX-09](AX-09-sdk-skills-must-tier.md), [AX-12](AX-12-product-skills-must-tier.md), [AX-14](AX-14-platform-skills-must-tier.md), [AX-17](AX-17-pkey-mcp-a-local-read-only-mcp-server.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                                                                                                 |
| Plan mode   | no                                                                                                                                                                                                                                                                                                                                                                 |
| Gates       | `drift-gate`, `ci`                                                                                                                                                                                                                                                                                                                                                 |
| Human input | none                                                                                                                                                                                                                                                                                                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                                          |

## Goal

`packages/agent-kit` is the plugin root with the two existing product skills moved in and linked back; the tag deploy stamps, zips and serves it; generated references and `pnpm skills:check` keep every skill true.

## Why

Public skills must reach the integrator's and the product maintainer's agents, who have no checkout of ours, without cloning a 310 MiB repo and without anyone getting `main`'s unreleased skills. Registered from [the LLM audit plan](../../../2026-10-08-llm-audit/README.md) (§5.1, §5.5, §8.3).

## Read first

- `AGENTS.md` (always).
- [The LLM audit plan](../../../2026-10-08-llm-audit/README.md): §5.1, §5.5, §8.3, and §2 (principles), §9 (how it fits the other plans), §10 (decisions).
- The docs [style guide](../../../2026-10-08-docs/style-guide.md) governs READMEs and skills.

## Scope

**In:**

- `packages/agent-kit/` as the plugin root (`.claude-plugin/plugin.json` with no committed `version`, `skills/`), the generated references and the knowledge bundle (plan §6.2).
- The two product skills moved in; `.claude/skills/<name>` links to `packages/agent-kit/skills/<name>`; paths and names stay as today; only briefs citing moved content are amended. No marketplace in `.claude/settings.json`; no `.mcp.json` in the plugin.
- The `skills` generator family in P0-42's registry writing every `references/*.md` from DOC-12a's outputs, SP-33a's renderers and `api.json`, with a GENERATED banner and the version; `pnpm gen --check` covers it.
- `pnpm skills:check` in the gate: frontmatter limits; line counts; reference depth; every repo path exists; DOC-03a's `pkey`-command, HTTP-path and programme-id lints; every docs URL a public page in the slug manifest and no gated sentence; SDK names in `api.json` and none on the removed-names list (once SP-35 lands); no `gh secret set`, `pkey release keys generate` or private-key PEM outside a hand-off block; `plugin.json` has no committed `version`; the built `marketplace.json` passes `claude plugin validate`.
- `deploy.yml` (tags only) stamps `plugin.json` (a new `STAMP_TARGETS` entry, never committed), zips the plugin and builds `polaris-key-<version>.zip` and a `marketplace.json` whose entry is an `archive` source pinned by `sha256`.
- `@polaris-key/agent-kit` as a deliverable in `.pkey/release.yaml`, published with the SDKs in lockstep. The CLI does not bundle it (esbuild bundle and OCI image).

**Out** (and where it belongs instead):

- Serving the zip and `marketplace.json` on key.plrs.im (→ AX-06).
- The SDK and product skills themselves (→ AX-09 to AX-13); platform skills (→ AX-14, AX-15).
- The package README (§3.2 row; AX-02's test covers it).

## Design notes

- Tier: must (required; gates 1.0 on its deterministic checks only). Wave 2 in the plan's order (§8.4). Model routing (§8.5): Sonnet 5.5 for the package, generators and lints; Opus 5.5 for the format rules' wording; set the model on every agent call, never inherit.
- Format is agentskills.io: `name` lowercase and hyphens, at most 64 characters; `description` third person, "Use when …", under 1,024 characters with `when_to_use` under 1,536; `SKILL.md` under 500 lines, aiming for 300; `references/` one level deep; a reference over 100 lines opens with contents.
- Triggers do not overlap: descriptions split by where the work happens (app code, `.pkey/` and the console, CI).
- Hotspot: AX-07 and P0-42 both touch the generator registry.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] `claude plugin validate` passes on the built marketplace.
- [ ] The plugin installs from a local directory marketplace in the harness and both skills load there and, through the links, in this repo.
- [ ] `npx skills add <local zip>` finds exactly the public skills.
- [ ] `skills:check` is in the gate and refuses each case listed in scope.
- [ ] Its eval report (plan §7.4) is attached to the hand-off: the suite and arms it should move, and the measured difference with its interval. It never blocks the merge.
- [ ] Any skill or README it writes or changes is reviewed against the plan's principle 9 (terse: each fact once, in the reader's words).
- [ ] `pkey-wp-reviewer` passes the package.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

AX-06 serves the zip; AX-08, AX-09, AX-12, AX-14 and AX-17 build on the kit.

The role agent sets `--set AX-07 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set AX-07 done`.
