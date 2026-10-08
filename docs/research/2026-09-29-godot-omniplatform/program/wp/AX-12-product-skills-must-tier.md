# AX-12 Product skills, must tier

| Field       | Value                                                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | AX: Agent experience: READMEs, llms files, skills, a CLI machines can drive and an eval harness (docs/research/2026-10-08-llm-audit/) (LLM audit (2026-10-08)) |
| Size        | 1.3–1.8 engineer-weeks                                                                                                                                         |
| Depends on  | [AX-05](AX-05-llm-eval-harness-suites-and-baseline.md), [AX-07](AX-07-the-agent-kit-layout-release-zip-references-lint.md)                                     |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [AX-13](AX-13-product-skills-should-tier.md), [AX-20](AX-20-evals-on-a-schedule-and-the-safety-bar.md)                 |
| Role        | `pkey-implementer`                                                                                                                                             |
| Plan mode   | no                                                                                                                                                             |
| Gates       | `docs-links`                                                                                                                                                   |
| Human input | none                                                                                                                                                           |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                      |

## Goal

The four must product skills ship in the agent kit: `authoring-pkey-manifests` (slimmed), `adding-a-catalog-entry` (widened), `registering-and-resyncing-a-product`, `setting-up-release-ci`.

## Why

Product tasks with no guide today: release CI, a sync that did nothing, the operator hand-off. A product maintainer's agent in a product repo has no checkout of ours. Registered from [the LLM audit plan](../../../2026-10-08-llm-audit/README.md) (§5.3, §8.3).

## Read first

- `AGENTS.md` (always).
- [The LLM audit plan](../../../2026-10-08-llm-audit/README.md): §5.3, §8.3, and §2 (principles), §9 (how it fits the other plans), §10 (decisions).
- The docs [style guide](../../../2026-10-08-docs/style-guide.md) governs READMEs and skills.

## Scope

**In:**

- The authoring split: `authoring-pkey-manifests` content moves into the skills below, it is not rewritten; the slimmed skill carries `references/minimal/` (a product, schema and release triple validated in CI) and `references/validation-codes.md` (from DOC-12a).
- `adding-a-catalog-entry` kept and widened: tiers, profiles and entitlement flags and how a purchase grants them; a worked entry; what happens after publish; whether `pkey validate` catches an unsupported keyword; prices, refunds and store credentials are console-only.
- `registering-and-resyncing-a-product` with `references/handoffs.md`.
- `setting-up-release-ci`: the person runs `pkey release keys generate` with `--out` outside the repo and stores the private key as the `PKEY_RELEASE_KEY` Environment secret; the agent adds only the printed public `releaseKeys` entry and the workflow. Carries `references/reasons.md` (generated once AX-16 registers the codes; `ci.md`'s table until then).
- The briefs that cite moved content are amended.

**Out** (and where it belongs instead):

- Should-tier product skills (→ AX-13).

## Design notes

- Tier: must (required; gates 1.0 on its deterministic checks only). Wave 2 in the plan's order (§8.4). Model routing (§8.5): Opus 5.5 for procedure and descriptions; Sonnet 5.5 for references; set the model on every agent call, never inherit.
- Every skill lists the steps only a person does, with the message to send them (principle 6).

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] As AX-09, plus the `references/minimal/` triple validates in CI.
- [ ] No `gh secret set`, `pkey release keys generate` or private-key PEM outside a hand-off block (`skills:check`).
- [ ] Its eval report (plan §7.4) is attached to the hand-off: the suite and arms it should move, and the measured difference with its interval. It never blocks the merge.
- [ ] Any skill or README it writes or changes is reviewed against the plan's principle 9 (terse: each fact once, in the reader's words).
- [ ] `pkey-wp-reviewer` passes the package.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

AX-13 extends the family; AX-16's reason codes replace `ci.md`'s table in `references/reasons.md`.

The role agent sets `--set AX-12 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set AX-12 done`.
