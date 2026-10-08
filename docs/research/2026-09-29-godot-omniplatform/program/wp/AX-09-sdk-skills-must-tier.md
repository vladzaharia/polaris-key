# AX-09 SDK skills, must tier

| Field       | Value                                                                                                                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | AX: Agent experience: READMEs, llms files, skills, a CLI machines can drive and an eval harness (docs/research/2026-10-08-llm-audit/) (LLM audit (2026-10-08))                                     |
| Size        | 1.3–1.8 engineer-weeks                                                                                                                                                                             |
| Depends on  | [AX-05](AX-05-llm-eval-harness-suites-and-baseline.md), [AX-07](AX-07-the-agent-kit-layout-release-zip-references-lint.md), [SP-45b](SP-45b-developer-docs-two-lanes-per-sdk-on-today-s.md)        |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [AX-10](AX-10-sdk-skills-should-tier.md), [AX-11](AX-11-drop-in-skills-servers-and-cli-hosts.md), [AX-20](AX-20-evals-on-a-schedule-and-the-safety-bar.md) |
| Role        | `pkey-sdk-porter`                                                                                                                                                                                  |
| Plan mode   | no                                                                                                                                                                                                 |
| Gates       | `docs-links`                                                                                                                                                                                       |
| Human input | none                                                                                                                                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                          |

## Goal

The five must SDK skills ship in the agent kit: `using-polaris-key`, `adding-licensing`, `adding-sign-in`, `reading-managed-config`, `debugging-a-polaris-key-integration`.

## Why

An integrator's agent has no checkout and little training data on Polaris Key; per-task skills with generated per-SDK references route it to the current API. Registered from [the LLM audit plan](../../../2026-10-08-llm-audit/README.md) (§5.2, §8.3).

## Read first

- `AGENTS.md` (always).
- [The LLM audit plan](../../../2026-10-08-llm-audit/README.md): §5.2, §8.3, and §2 (principles), §9 (how it fits the other plans), §10 (decisions).
- The docs [style guide](../../../2026-10-08-docs/style-guide.md) governs READMEs and skills.

## Scope

**In:**

- `using-polaris-key`: orients and installs; carries `references/hosts.md` (from `sdkFit`), `references/<ecosystem>.md` (install steps), `references/handoffs.md` (each console step and the message to send) and `scripts/check-versions.mjs` (lockfiles against the feed's lockstep version).
- `adding-licensing`: carries `references/<sdk>.md` (both lanes, from `renderUsage`), `references/cli-<framework>.md` (after SP-64) and `references/states.md` (DOC-08b's states).
- `adding-sign-in`; `reading-managed-config`; `debugging-a-polaris-key-integration` (runs `pkey doctor`, the SDK's `doctor()` and `pkey explain`; carries `references/codes.md` from DOC-12a).
- Each skill: description per plan §5.2, a stop-and-ask list with the message to send, a verify step that is a real command, links to `.md` pages; at least five should-load and three should-not trigger cases and at least one eval task.

**Out** (and where it belongs instead):

- The should-tier SDK skills (→ AX-10); server and CLI-host skills (→ AX-11).

## Design notes

- Tier: must (required; gates 1.0 on its deterministic checks only). Wave 3 in the plan's order (§8.4). Model routing (§8.5): Opus 5.5 for procedure and descriptions; Sonnet 5.5 for references and code; set the model on every agent call, never inherit.
- Skills name only the current API (the no-alias rule). Code fences tagged with an SDK compile in SP-45's snippet lane. The hub's PyPI and GitHub Packages trap (X8) is covered in `using-polaris-key`.
- Procedure and trigger descriptions are judgement work (Opus 5.5).

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] `skills:check` passes.
- [ ] Each skill's SDK-tagged fences compile in the snippet lane.
- [ ] Each skill's trigger cases are recorded; the trigger evals check each should-prompt loads exactly one public skill.
- [ ] Reviewed against principle 9 (terse).
- [ ] Its eval report (plan §7.4) is attached to the hand-off: the suite and arms it should move, and the measured difference with its interval. It never blocks the merge.
- [ ] Any skill or README it writes or changes is reviewed against the plan's principle 9 (terse: each fact once, in the reader's words).
- [ ] `pkey-wp-reviewer` passes the package.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

AX-10 and AX-11 extend the family; AX-20's safety bar covers these skills.

The role agent sets `--set AX-09 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set AX-09 done`.
