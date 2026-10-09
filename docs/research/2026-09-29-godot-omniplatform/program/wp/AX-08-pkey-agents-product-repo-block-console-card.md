# AX-08 `pkey agents`, the product-repo block, the console card

| Field       | Value                                                                                                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | AX: Agent experience: READMEs, llms files, skills, a CLI machines can drive and an eval harness (docs/research/2026-10-08-llm-audit/) (LLM audit (2026-10-08))               |
| Size        | 0.8–1.2 engineer-weeks                                                                                                                                                       |
| Depends on  | [AX-07](AX-07-the-agent-kit-layout-release-zip-references-lint.md), [P0-45](P0-45-pkey-command-registry-context-doctor.md), [ST-41](ST-41-integration-page-overview-card.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                                                                                       |
| Role        | `pkey-implementer`                                                                                                                                                           |
| Plan mode   | no                                                                                                                                                                           |
| Gates       | `threat-model`, `ui-snapshots`, `docs-links`                                                                                                                                 |
| Human input | none                                                                                                                                                                         |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                    |

## Goal

`pkey agents --write` gives a product repo the always-on layer: a marked `AGENTS.md` block, the `CLAUDE.md` import, optionally the plugin registration; the public `start/ai-agents` page and the console's **Set up with your agent** card say the same.

## Why

A product maintainer's agent works in a repo with no checkout of ours; Claude Code skips `AGENTS.md` when a `CLAUDE.md` exists; the agent needs to know the product's slug, services, SDKs, commands and hand-offs. Registered from [the LLM audit plan](../../../2026-10-08-llm-audit/README.md) (§4.5, §8.3).

## Read first

- `AGENTS.md` (always).
- [The LLM audit plan](../../../2026-10-08-llm-audit/README.md): §4.5, §8.3, and §2 (principles), §9 (how it fits the other plans), §10 (decisions).
- The docs [style guide](../../../2026-10-08-docs/style-guide.md) governs READMEs and skills.

## Scope

**In:**

- `pkey agents --write` (interactive `pkey init` offers it, ST-46): writes or refreshes a marked block in the repo's `AGENTS.md` (`<!-- polaris-key:begin v0.9.N -->` … `<!-- polaris-key:end -->`), under 60 lines: slug and services from `.pkey/product`, the SDKs `sdkFit` finds (npm, PyPI, Gradle, SwiftPM and Godot signals, not lockfiles alone), the commands the installed CLI has (from P0-45's registry), the hub's rules, the hand-off list, which skill for which task.
- Adds `@AGENTS.md` inside its own marker to an existing `CLAUDE.md` or `.claude/CLAUDE.md`; with only a `CLAUDE.local.md`, says so and edits nothing personal.
- With `--claude`, registers the marketplace and enables the plugin in the repo's `.claude/settings.json` (what `claude plugin marketplace add --scope project` writes); never copies skills. With `--mcp` (after AX-17), adds `pkey mcp` to `.mcp.json`; no token is ever written there.
- Idempotent, never edits outside its markers, refuses paths outside the repo. Imports the kit lazily at the CLI's exact version and prints the install command when missing.
- The public page `start/ai-agents` (the docs plan's "Set up your agent"): the same in three steps.
- The console Integration page (ST-41) gets a **Set up with your agent** card: the `pkey agents --write` and plugin commands and a starter prompt with this product's slug and services. It never shows a secret. Mockup first; `pkey-ux-reviewer` in both modes.

**Out** (and where it belongs instead):

- Cursor and Codex skill directories (later, once an eval covers one).
- The `--mcp` target before `pkey mcp` exists (→ AX-17).
- Interactive init's offer (→ ST-46 amendment).

## Design notes

- Tier: must (required; gates 1.0 on its deterministic checks only). Wave 3 in the plan's order (§8.4). Model routing (§8.5): Sonnet 5.5; security review Sonnet 5.5; UX review Opus 5.5; set the model on every agent call, never inherit.
- Writes into user repos: security review on Sonnet 5.5. UX review of the card on Opus 5.5.

## Screen acceptance (brand transition, 2026-10-09)

Done when every row holds for each screen and state this package ships, checked in the real runtime
(not mockups; native kits on device or simulator), with evidence paths in the PR. A row that cannot
apply says why in one line. One home: EXPERIENCE.md §7.3; kits also follow DL1–DL18.

- [ ] Keyboard: tab order follows reading order; focus always visible (DL9); no trap outside a modal;
      Escape or Cancel backs out of every overlay and step; focus returns to the opener (or the heading
      when it is gone); a route change changes the URL and moves focus to the h1, an inline mutation
      changes neither.
- [ ] Screen readers: landmarks and exactly one h1; every icon-only control named; help and errors
      linked (aria-describedby); one polite announcement per change, none while typing; tables use
      th with scope; status is a word and an icon, never colour alone.
- [ ] Sizing: this surface's UI-KITS §7.1 rows plus 200 % text and 400 % zoom (320 CSS px reflow) with
      no page-level sideways scroll; a dense table scrolls only inside a labelled, focusable region;
      targets ≥ 44 px on customer and touch surfaces, ≥ 24 px with separation in the console.
- [ ] Themes: dark and light; a custom product accent on a light and a dark ground (kits, hosted
      sign-in); forced-colors; prefers-contrast: more; reduced transparency; contrast measured on the render (text 4.5:1, UI 3:1) for every state colour in its service accent, both themes.
- [ ] States: loading (skeleton after the grace), first-run empty, filtered empty, permission refused,
      expired or stale, network and API error with Try again, partial failure, success; input survives a
      failed save; where the API sends expectedVersion, a changed-since-open conflict is named with
      Reload.
- [ ] Motion: tokens only; reduced motion is an instant swap and the outcome still reads; errors appear
      without moving content; progress is real (no invented percentage, nothing loops after a failure);
      no celebration on refunds, revocation, removal, deletion or consent.
- [ ] Hierarchy and copy: one filled primary per state (neutral action ink in console, portal and hosted
      sign-in; the product accent in kits); focus, selected, hover, checked and context
      borders take the accent of the service the element references (data-service; -fg for
      text and edges, base for fills; a non-colour cue stays); status colours (success,
      warning, danger, info, signed) never become a service accent; copy from the catalog, each fact once; no decorative numbers or
      taglines; no text drawn over customer art.
- [ ] Native (kits): Dynamic Type or font scale at the 200 % row, VoiceOver or TalkBack, gamepad and
      D-pad focus, TV and title-safe insets, terminal keys with NO_COLOR, ascii and --json paths.
- [ ] pkey-ux-reviewer passes the built screens (BUILT mode).

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] A second run changes nothing.
- [ ] Tests refuse a write outside the repo, outside the markers, or of a token.
- [ ] The `CLAUDE.md` import lands and is idempotent.
- [ ] The block is under 60 lines.
- [ ] A security review.
- [ ] Mockup approved and the built card reviewed by `pkey-ux-reviewer` in both modes.
- [ ] Its eval report (plan §7.4) is attached to the hand-off: the suite and arms it should move, and the measured difference with its interval. It never blocks the merge.
- [ ] Any skill or README it writes or changes is reviewed against the plan's principle 9 (terse: each fact once, in the reader's words).
- [ ] `pkey-wp-reviewer` passes the package.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

AX-17 adds the `--mcp` flag's target; ST-46 offers this command from `pkey init`.

The role agent sets `--set AX-08 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set AX-08 done`.
