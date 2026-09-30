---
name: running-the-omniplatform-program
description: Use when leading or continuing the Godot-on-Polaris-Key execution program (docs/research/2026-09-29-godot-omniplatform/program/) - choosing ready work packages, dispatching the pkey-* role agents, routing plan-mode work through approval, reviewing, updating statuses and escalating to the human.
---

# Running the omniplatform program

The program lives in `docs/research/2026-09-29-godot-omniplatform/program/`. Its `README.md` is the operating manual; this skill is the lead's checklist. You are the **lead**: you dispatch and integrate, and the role agents in `.claude/agents/pkey-*.md` do the work.

## Each session

- [ ] Read `AGENTS.md`, `CLAUDE.md` and `program/README.md` (§3 the loop, §5 hotspots, §6 human inputs).
- [ ] Pull the default branch. Run `node program/check.mjs` and fix any graph error first.
- [ ] Review what is in flight: `node program/check.mjs --summary`, and the open `wp/*` branches and PRs.
- [ ] For each `awaiting-approval` plan, ask the human for a decision. Do not implement unapproved plans.

## Dispatching

- [ ] Run `node program/check.mjs --ready`. Take from the top, respecting the §5 hotspot rules:
  - one corpus-touching package at a time;
  - protocol changes only inside approved plans;
  - migrations numbered on rebase.
- [ ] Skip ✋ packages whose human inputs are missing. Ask for those inputs in one message, grouped by provider.
- [ ] Send ⚑ (plan-mode) packages to `pkey-wire-planner` first.
- [ ] Start every other package with the role named in `workpackages.json`. Give the agent:
  - the work-package id;
  - the brief path;
  - the branch name `wp/<ID>-<slug>`;
  - any human inputs received.

  Independent packages run in parallel, and one message can start several agents.

- [ ] `D-*` packages run in `vladzaharia/diceroll`, which must be attached to the session first.

## When an agent reports

- [ ] Start `pkey-wp-reviewer` on the branch. Send blocking findings back to the same role agent (continue it rather than starting fresh), and repeat until it passes.
- [ ] Check that the PR body carries the brief's acceptance checklist, and that the status is `in-review` in `workpackages.json`.
- [ ] When the reviewer passes it, add the PR's last commit: the brief's hand-off line `check.mjs --set <ID> done`, then prettier on `workpackages.json` and `INDEX.md`. Hand the PR to the human to merge. After the merge:
  - confirm the status reads `done` on the default branch;
  - re-run `--ready`;
  - update any downstream brief whose named interface changed.
- [ ] Record deviations the agent reported. A scope or estimate change of more than half goes to the human before more work is dispatched on that line.

## Escalate to the human, and pause the affected line, when

- a hard rule in `AGENTS.md` would have to bend;
- a plan needs a decision the research left open;
- a human-held input is missing (accounts, keys, devices, deploys, the P0-08 production deploy before any new service slug);
- two briefs contradict each other, or the code contradicts a brief in a way that changes scope.

## When the graph changes

- [ ] Edit `workpackages.json` and the briefs, then run `check.mjs --sync-briefs`, then `--write-index`, then prettier, then `check.mjs` (program README §8).
- [ ] Turn items from the README's "Known gaps without a work package" into packages when their phase approaches.

## Never

- Merge PRs, deploy, create cloud resources or store credentials on the human's behalf, unless the human has explicitly delegated that.
- Hand-edit `INDEX.md`, the corpus or generated docs.
- Renumber a work package that has started.
