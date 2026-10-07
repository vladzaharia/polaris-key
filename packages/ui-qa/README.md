# @polaris-key/ui-qa

Visual QA for the Polaris Key UI kits ([UI-KITS.md §7](../../docs/design/UI-KITS.md#7-visual-qa)).
Private: tooling, not a published package.

| Command                                        | What it does                                                                                                                                                                                                                                  |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm ui:lint`                                 | The §7.3 modernity lint over every mockup board in both themes, the string lint across boards, and the native kits' source lints. Exit 1 on any finding. `--board=web,ios`, `--theme=dark`, `--css=<file>`, `--html=<path or URL>`, `--json`. |
| `pnpm ui:report`                               | Every kit's baselines beside the mockups, per state and theme, in `.out/report/index.html`; the React/elements pixel diff once both exist.                                                                                                    |
| `node packages/ui-qa/bin/kit-lint.mjs --kit=…` | The SwiftUI, Compose, Godot, Qt and Node terminal source rules, with no install (each kit's CI lane runs it).                                                                                                                                 |
| `pnpm --filter @polaris-key/ui-qa test:e2e`    | The lint's browser suites: a seeded violation for each rule, and the boards clean.                                                                                                                                                            |

## Pieces

- `src/browser/lint.js` is the in-page lint (injected as a plain script). `src/run.ts` has
  `lintPage(page)` for a kit's own Playwright component tests (call `prepare(page)` before
  navigating, so `alert()` calls are recorded).
- `src/boards.ts` lists each board's chrome, touch variants and allowances, each with its reason.
  `src/config.ts` holds the rule profiles (`web`, `native`) and the baseline folders.
- `src/strings.ts` is the string lint. `rules/strings.allow.json` lists fixture strings, each with
  its reason. `rules/strings.debt.json` records copy drift that predates the lint. The ledger only
  shrinks: re-record with `pnpm ui:lint --record-string-debt`.
- `bin/kit-lint.mjs` is the per-kit source lint. `rules/kit-rules.json` holds the rules, and
  `rules/kit-debt.json` records the hits each kit's work package clears (re-record with `--record`).
- The runtime helpers for native kits live in the kits' own trees: `sdks/godot/tests/support/ui_lint.gd`
  and `sdks/python/tests/ui_lint_qt.py`.
- The review checklist is [docs/design/ui-kits/REVIEW.md](../../docs/design/ui-kits/REVIEW.md).
