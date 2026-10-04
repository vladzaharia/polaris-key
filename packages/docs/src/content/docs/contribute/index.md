---
title: "Contributing"
description: "Setup, the monorepo layout, service boundaries, the contract-first wave model, the conformance corpus, and how releases ship."
sidebar:
  order: 1
---

Polaris Key is a **contract-first, seven-language** monorepo: one Cloudflare Worker plus SDKs
for Node, React, Python, Swift, Godot and Kotlin, all agreeing on a single frozen wire format. The rule that
follows from that shapes everything in this section: **the wire contract is the source of
truth, and every language must verify it identically.**

**`CONTRIBUTING.md`** at the repo root is the canonical, git-tracked contributor guide — the
framing above, setup, the green-gate commands, and pre-commit hooks, readable on GitHub before
you ever sign in here. This section carries the rest of the same material, in more depth.
Agents working in this repo follow `AGENTS.md` instead — the short, enforceable version of the
same rules.

Terminology throughout follows [Concepts & terminology](/docs/start/concepts/); when code and
the glossary disagree, the glossary wins.

## In this section

| Page                                                     | What it covers                                                                                                                                           |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Setup](/docs/contribute/setup/)                         | Installing the JS workspace, the Python SDK, and the Swift, Godot and Kotlin toolchains; why Node must be 22; the green-gate commands; pre-commit hooks. |
| [Monorepo layout](/docs/contribute/layout/)              | The full package map, the Worker's `core/` + `services/<slug>/` split, the boundary test that enforces it, and `mount.ts` as the composition root.       |
| [The contract-first wave model](/docs/contribute/waves/) | The contract → catalog → corpus → SDKs ordering, a six-language walkthrough for a wire-visible field, and the full drift-gate inventory.                 |
| [The conformance corpus](/docs/contribute/corpus/)       | How one generator, the language runners and the generator-owned mirrors keep the implementations byte-identical, and how to add a case.                  |
| [Releasing](/docs/contribute/releasing/)                 | The Changesets flow for the JS SDKs, the Python and Swift tag releases, and how the worker deploys.                                                      |
| [Adding a package feed](/docs/contribute/package-feeds/) | The `FeedAdapter` contract every registry-host feed implements, what stays shared, and the checklist the adapter conformance suite enforces.             |
