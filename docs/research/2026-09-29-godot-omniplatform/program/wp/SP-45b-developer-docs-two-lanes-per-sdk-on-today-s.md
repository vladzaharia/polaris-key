# SP-45b Developer docs, two lanes per SDK on today's API: Swift, Kotlin, Godot

| Field       | Value                                                                              |
| ----------- | ---------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (SDK usability review (2026-10-08)) |
| Size        | 1.2–1.6 engineer-weeks                                                             |
| Depends on  | [SP-45a](SP-45a-developer-docs-two-lanes-per-sdk-on-today-s.md)                    |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [AX-09](AX-09-sdk-skills-must-tier.md)     |
| Role        | `pkey-implementer`                                                                 |
| Plan mode   | no                                                                                 |
| Gates       | `docs-generated`, `docs-links`, `ci`, `ci:macos`                                   |
| Human input | none                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                          |

## LLM audit (2026-10-08)

The [LLM audit plan](../../../2026-10-08-llm-audit/README.md) §9 changes this package. Where it differs from the text below, it wins.

- The snippet lane also compiles SDK-tagged fences under `packages/agent-kit/skills/` (AX-07 and the skill packages). AX-09 waits for this package.

## Goal

Developer docs, two lanes per SDK on today's API: Swift, Kotlin, Godot, as the [SDK usability review](../../../2026-10-08-sdk-usability/README.md) §10.2 scopes it. Done when every acceptance criterion holds and the green gate passes.

## Why

Eighteen hands-on trials across Node, React, Python, Swift, Kotlin and Godot (the drop-in kit, your own UI, and a newcomer) averaged 5.3/10. This package fixes what they found; the evidence is in [`findings.json`](../../../2026-10-08-sdk-usability/findings.json) and the review's §5 and §7.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [The SDK usability review](../../../2026-10-08-sdk-usability/README.md): §1, §5, the SDK's part of §7, §10.2 (SP-45b) and §10.4.

## Scope

**In:** the lane skeleton of §4.1; a doc-snippet extractor (fenced blocks in every SDK README and docs page, by language, with an opt-out marker) and compile lanes; status badges on `build/ui/index.mdx`, framework pages and component tabs; shipped names in the layer table, spec names labelled; terminal and Electron rows; UI-KITS §4.2 amended to the `polaris-key.json` shape; `DOCS_LINKS` entries for every console link in §4.2. _(a)_ Node, React and Python: the pages and fixes in §4.2. _(b)_ Swift, Kotlin and Godot: the pages and fixes in §4.2, the Xcode install tab, the Compose Desktop recipe, the Godot class-name drift check and AssetLib metadata.

**Out** (and where it belongs instead):

- The 0.9 rebuilds and renames (→ SP-35, SP-35b and the UK kit packages); anything §10.1 gives an existing package.

## Design notes

- Builds on SP-45a's skeleton and snippet lane.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] For each SDK, both lanes reach the eight checkpoints.
- [ ] Every code block on the new and changed pages compiles in its lane, and a deliberately broken block fails CI.
- [ ] A check fails when a page names a symbol the SDK does not export.
- [ ] Docs-links and the slug manifest pass.
- [ ] A newcomer dry run per SDK is recorded in the PR.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its SDK lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set SP-45b in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-45b done`.
