---
title: "Working on this system as an agent"
description: "Repo conventions, the green gate, and task recipes. AGENTS.md in the repo is canonical."
sidebar:
  order: 1
type: "concept"
lastReviewed: "2026-10-16"
---

This section is for **coding agents** — and for the humans who direct them — working on Polaris
Key itself or on a product that adopts it.

It is deliberately thin, because the important material is not here.

## The doctrine: the repo is canonical, this section is recipes

**`AGENTS.md` at the repository root is the canonical instruction file.** It carries the repo
map, the Node 22 toolchain constraint, the full green gate, and the hard rules — the
things an agent must not get wrong. It is vendor-neutral: `CLAUDE.md` beside it is a short
pointer that adds only Claude-Code-specific wiring (which skills exist, plan-mode expectations
for wire-touching changes), and any other tool's file should be the same shape.

Everything in this section is downstream of that file:

| Page                                                | What it is                                                                                                    |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [Task recipes](/docs/contribute/agents/recipes/)    | Six common tasks as task → steps → verify tables, each pointing at the deep page and ending in a real command |
| [Conventions](/docs/contribute/agents/conventions/) | Where the hard rules, the green gate and the drift gates are explained                                        |

When this section and `AGENTS.md` disagree, `AGENTS.md` wins. Treat a disagreement as a bug in
this section and fix it here.

## What to read

The agent-readable source of truth is **the repository**, not the deployed site:

- `AGENTS.md`: conventions, gates, hard rules. Read first, always.
- `CLAUDE.md`: Claude Code specifics only.
- `.claude/skills/`: packaged procedures, among them `authoring-pkey-manifests`,
  `adding-a-catalog-entry` and `running-the-omniplatform-program`.
- `CONTRIBUTING.md`, `README.md`, `docs/`: the long-form human material, all git-tracked.

## The one-paragraph orientation

Polaris Key is a contract-first, seven-language monorepo: one Cloudflare Worker plus SDKs for
Node, React, Python, Swift, Godot and Kotlin, all agreeing on a single frozen wire format. The wire contract is
the source of truth and every language must verify it identically — which is why a wire change is
an all-languages event (contract → catalog → corpus → SDKs), why the conformance corpus is
generated rather than written, and why so much of this repo is drift gates. Start at
[What is Polaris Key?](/docs/start/) for the system, or go straight to
[Task recipes](/docs/contribute/agents/recipes/) if you already know what you are changing.
