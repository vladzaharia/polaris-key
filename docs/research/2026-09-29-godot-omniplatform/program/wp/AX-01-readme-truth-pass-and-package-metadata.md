# AX-01 README truth pass and package metadata

| Field       | Value                                                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | AX: Agent experience: READMEs, llms files, skills, a CLI machines can drive and an eval harness (docs/research/2026-10-08-llm-audit/) (LLM audit (2026-10-08)) |
| Size        | 0.4–0.6 engineer-weeks                                                                                                                                         |
| Depends on  | none                                                                                                                                                           |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                                                                         |
| Role        | `pkey-implementer`                                                                                                                                             |
| Plan mode   | no                                                                                                                                                             |
| Gates       | `docs-links`                                                                                                                                                   |
| Human input | none                                                                                                                                                           |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                      |

## Goal

The root `README.md`, `packages/client-core`, `packages/brand` and `examples/` READMEs are true to the repo, and every published package carries complete npm metadata, held by `package-metadata.test.ts`.

## Why

The audits scored the root README 5 (stale layout block, broken nested backticks, test counts, no start-here by task); published npm packages other than `brand` and `zstd-wasm` have no `description` and none has `keywords`, `repository`, `homepage` or `bugs`; Godot's `plugin.cfg` describes only JWS verification; `examples/` lists 4 of 6 samples; `client-core` cites WIRE-CONTRACT-V3. Registered from [the LLM audit plan](../../../2026-10-08-llm-audit/README.md) (§3.1, §3.2, §8.3).

## Read first

- `AGENTS.md` (always).
- [The LLM audit plan](../../../2026-10-08-llm-audit/README.md): §3.1, §3.2, §8.3, and §2 (principles), §9 (how it fits the other plans), §10 (decisions).
- The docs [style guide](../../../2026-10-08-docs/style-guide.md) governs READMEs and skills.

## Scope

**In:**

- §3.2's AX-01 rows: `README.md` (router: start-here table by task, layout from the workspace, docs by door), `packages/client-core` (V4 sections: WIRE-CONTRACT-V4 supersedes V3 and restates it, so every V3 citation moves), `packages/brand` (metadata only), `examples/` (every sample).
- `description`, `keywords`, `repository`, `homepage` and `bugs` on every published package; the Godot `plugin.cfg` description.
- `package-metadata.test.ts`: the five fields on every published package, and no root-relative `/docs/` link in a published README.

**Out** (and where it belongs instead):

- The SDK READMEs (node, react, python, swift, kotlin, kotlin/ui, godot) (→ SP-37, amended by the plan's §3.1 template).
- READMEs for directories that have none (→ AX-02).
- Docs lines that are unsafe (→ P0-48); AX-01 leaves them alone.

## Design notes

- Tier: must (required; gates 1.0 on its deterministic checks only). Wave 1 in the plan's order (§8.4). Model routing (§8.5): Sonnet 5.5 (READMEs written from the code); set the model on every agent call, never inherit.
- Published READMEs follow the §3.1 template in the plan; the README at the root is the router, not a published package.
- The `brand` and `zstd-wasm` `description` correction was made in the plan's review: they already have one.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] `package-metadata.test.ts` passes: `description`, `keywords`, `repository`, `homepage` and `bugs` on every published package; no root-relative `/docs/` link in a published README.
- [ ] Godot's `plugin.cfg` describes the whole addon, not only JWS verification.
- [ ] The root `README.md` has a start-here table (use an SDK / run a product / change the platform), a layout block generated or checked against the workspace, and no test counts.
- [ ] `packages/client-core` cites the V4 sections, no V3.
- [ ] Its eval report (plan §7.4) is attached to the hand-off: the suite and arms it should move, and the measured difference with its interval. It never blocks the merge.
- [ ] Any skill or README it writes or changes is reviewed against the plan's principle 9 (terse: each fact once, in the reader's words).
- [ ] `pkey-wp-reviewer` passes the package.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

AX-02 follows the root README's layout block; AX-03b's repo map links each README.

The role agent sets `--set AX-01 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set AX-01 done`.
