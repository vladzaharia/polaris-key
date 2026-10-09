# AX-02 READMEs for every directory without one

| Field       | Value                                                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | AX: Agent experience: READMEs, llms files, skills, a CLI machines can drive and an eval harness (docs/research/2026-10-08-llm-audit/) (LLM audit (2026-10-08)) |
| Size        | 1–1.4 engineer-weeks                                                                                                                                           |
| Depends on  | [P0-42](P0-42-generator-registry-pnpm-gen.md)                                                                                                                  |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                                                                         |
| Role        | `pkey-implementer`                                                                                                                                             |
| Plan mode   | no                                                                                                                                                             |
| Gates       | `docs-generated`                                                                                                                                               |
| Human input | none                                                                                                                                                           |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                      |

## Goal

Every workspace package and top-level directory has a README in its variant's shape (published or internal), and `readme-coverage.test.ts` holds it.

## Why

Twelve directories have no README (`worker`, `admin`, `docs`, `shared-protocol`, `shared-jws`, `shared-catalog`, `shared-manifest`, `zstd-wasm`, `conformance/`, `tools/`, `products/`, `actions/publish`); five of them publish to the feed blank. Registered from [the LLM audit plan](../../../2026-10-08-llm-audit/README.md) (§3.1, §3.2, §8.3).

## Read first

- `AGENTS.md` (always).
- [The LLM audit plan](../../../2026-10-08-llm-audit/README.md): §3.1, §3.2, §8.3, and §2 (principles), §9 (how it fits the other plans), §10 (decisions).
- The docs [style guide](../../../2026-10-08-docs/style-guide.md) governs READMEs and skills.

## Scope

**In:**

- §3.2's AX-02 rows: `packages/shared-manifest` (schemas and public URLs, validator API, link to validation codes), `packages/shared-protocol`, `shared-jws`, `shared-catalog` (what each exports and who uses it), `packages/zstd-wasm` (build pinned to zstd 1.5.7), `packages/worker`, `packages/admin`, `packages/docs`, `conformance/` (takes rule 1's detail from `AGENTS.md`), `tools/`, `products/`, `docs/`, `actions/publish` (permissions, minimal workflow, pin by commit SHA with a `# vX.Y.Z` comment, link to the generated Action reference).
- "Work on it" sections generated from `tools/generators.ts`, never typed.
- `readme-coverage.test.ts`: every workspace package and top-level directory, `docs/`, `evals/` and `packages/agent-kit` included, has a README with its variant's headings.

**Out** (and where it belongs instead):

- The `evals/` README (→ AX-05) and the `packages/agent-kit` README (→ AX-07); the coverage test covers them, so it runs against them as they land.
- SDK READMEs (→ SP-37). CLI README additions (→ AX-16, AX-08, AX-17).

## Design notes

- Tier: must (required; gates 1.0 on its deterministic checks only). Wave 2 in the plan's order (§8.4). Model routing (§8.5): Sonnet 5.5 (READMEs written from the code); set the model on every agent call, never inherit.
- Internal template: name and job, where it sits, layout, work on it, rules here (linked by anchor, never by number), docs. Under 150 lines.
- Ordering: AX-05 and AX-07 own the `evals/` and `packages/agent-kit` READMEs but the plan makes AX-02's test cover them without listing them as dependencies. The lead orders the merge, or the test skips a directory that does not exist yet (plan ambiguity, flagged at registration).

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] `readme-coverage.test.ts` passes.
- [ ] "Work on it" in each internal README is generated from `tools/generators.ts`.
- [ ] `actions/publish/README.md` pins by commit SHA with a version comment and links the generated Action reference.
- [ ] Its eval report (plan §7.4) is attached to the hand-off: the suite and arms it should move, and the measured difference with its interval. It never blocks the merge.
- [ ] Any skill or README it writes or changes is reviewed against the plan's principle 9 (terse: each fact once, in the reader's words).
- [ ] `pkey-wp-reviewer` passes the package.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

AX-03b's repo map links each README by path.

The role agent sets `--set AX-02 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set AX-02 done`.
