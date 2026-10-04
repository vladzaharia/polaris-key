---
title: "Working on this system as an agent"
description: "Repo conventions, the green gate, and task recipes. AGENTS.md in the repo is canonical."
sidebar:
  order: 1
---

This section is for **coding agents** — and for the humans who direct them — working on Polaris
Key itself or on a product that adopts it.

It is deliberately thin, because the important material is not here.

## The doctrine: the repo is canonical, this section is recipes

**`AGENTS.md` at the repository root is the canonical instruction file.** It carries the repo
map, the Node 22 toolchain constraint, the full green gate, and the eleven hard rules — the
things an agent must not get wrong. It is vendor-neutral: `CLAUDE.md` beside it is a twenty-line
pointer that adds only Claude-Code-specific wiring (which skills exist, plan-mode expectations
for wire-touching changes), and any other tool's file should be the same shape.

Everything in this section is downstream of that file:

| Page                                     | What it is                                                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [Task recipes](/docs/agents/recipes/)    | Six common tasks as task → steps → verify tables, each pointing at the deep page and ending in a real command |
| [Conventions](/docs/agents/conventions/) | The green gate and hard rules distilled, plus the full drift-gate inventory                                   |

When this section and `AGENTS.md` disagree, `AGENTS.md` wins. Treat a disagreement as a bug in
this section and fix it here.

## Why there is no `llms.txt`

The usual answer for "make a docs site legible to agents" is to publish `llms.txt` and a set of
flat markdown mirrors at a stable public URL. That is the wrong shape for this site.

`key.plrs.im/docs` is served by the same worker as the console, **behind the same platform-admin
session gate**. There is no public docs origin. That is a deliberate trade: because the site is
gated, it can carry the real runbook, the real deployment procedure, and real operational values
instead of a sanitised public subset. An `llms.txt` at a gated origin fetches a login page, and a
public one would either be empty or would leak exactly the material the gate exists to protect.

So the agent-readable source of truth is **the repository**, not the deployed site:

- `AGENTS.md` — conventions, gates, hard rules. Read first, always.
- `CLAUDE.md` — Claude Code specifics only.
- `.claude/skills/` — three packaged procedures: `authoring-pkey-manifests`,
  `adding-a-catalog-entry` and `running-the-omniplatform-program`. The last one drives the role
  agents in `.claude/agents/` through the work packages of the Godot-on-Polaris-Key program.
- `CONTRIBUTING.md`, `README.md`, `docs/` — the long-form human material, all git-tracked.
- The tests named in [Conventions](/docs/agents/conventions/) — every rule that matters is
  enforced by one, so an agent can check its own work without reading prose at all.

An agent with a checkout has everything. An agent with only a URL has a login page — which is the
correct outcome, not a gap to paper over.

## The one-paragraph orientation

Polaris Key is a contract-first, seven-language monorepo: one Cloudflare Worker plus SDKs for
Node, React, Python, Swift, Godot and Kotlin, all agreeing on a single frozen wire format. The wire contract is
the source of truth and every language must verify it identically — which is why a wire change is
an all-languages event (contract → catalog → corpus → SDKs), why the conformance corpus is
generated rather than written, and why so much of this repo is drift gates. Start at
[What is Polaris Key?](/docs/start/) for the system, or go straight to
[Task recipes](/docs/agents/recipes/) if you already know what you are changing.
