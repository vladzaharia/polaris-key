# @polaris-key/ui-qa

Visual QA for the Polaris Key UI kits ([UI-KITS.md §7](../../docs/design/UI-KITS.md#7-visual-qa)): the modernity lint, the string lint, the per-kit source lints, the side-by-side report and the cross-renderer pixel diff.

## Where it sits

The package is private tooling. The root scripts `pnpm ui:lint` and `pnpm ui:report` call it (`src/cli/lint.ts`, `src/cli/report.ts`), and so does the `ui-kits` job in `.github/workflows/ci.yml`, which runs both plus the package's e2e suite. The native kits' CI lanes run `bin/kit-lint.mjs` directly.

It reads the mockup boards in [`docs/design/ui-kits/`](../../docs/design/ui-kits/) and each kit's sources and baseline shots.

## Layout

```
src/
  browser/lint.js   the in-page lint, injected as a plain script
  cli/              lint.ts and report.ts, the two root-script entry points
  run.ts            lintPage(page), prepare(page)
  boards.ts         each board's chrome, touch variants and allowances
  config.ts         rule profiles (web, native) and baseline folders
  rules.ts          the modernity rules
  strings.ts        the string lint
  ux-bar.ts         the console and customer-site UX bar (B6, B7, B17) over the rendered DOM
  kits.ts           re-exports the per-kit source lints
  report.ts         the side-by-side report
  pixeldiff.ts      the cross-renderer pixel diff
bin/
  kit-lint.mjs      the per-kit source lint, zero dependencies
rules/
  strings.allow.json   fixture strings, each with its reason
  strings.debt.json    copy drift that predates the lint
  kit-rules.json       the per-kit source rules
  kit-debt.json        hits each kit's work clears
e2e/                browser suites: a seeded violation per rule, and clean boards
test/               unit tests
```

- `uxBarFindings(page, { focus })` (UK-63) is the brand-transition bar for the built console and customer site: coloured shadows and glows, gradients, accent-tinted rims, an eyebrow repeating the breadcrumb, taglines, a name drawn over art, weight 700, a focus ring that is not the service ring, and a blur kept under reduced transparency. The admin package's `e2e/portalUxBar.e2e.test.ts` and `e2e/layout.e2e.test.ts` run it; breaches that predate it are `UX_BAR_DEBT` in `packages/admin/e2e/uxBar.ts`, which only shrinks. `PK_UXBAR_COLLECT=<file>` records every finding instead of failing.
- `lintPage(page)` serves a kit's own Playwright component tests. Call `prepare(page)` before navigating, so `alert()` calls are recorded.
- `rules/strings.debt.json` only shrinks. Re-record it with `pnpm ui:lint --record-string-debt`.
- `rules/kit-debt.json` only shrinks. Re-record it with `--record` on `bin/kit-lint.mjs`.
- The runtime helpers for native kits live in the kits' own trees: `sdks/godot/tests/support/ui_lint.gd` and `sdks/python/tests/ui_lint_qt.py`.

### Commands

| Command                                        | What it does                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm ui:lint`                                 | The §7.3 modernity lint over every mockup board in both themes, the string lint across boards, and the native kits' source lints. Exit 1 on any finding. `--board=web,ios`, `--theme=dark`, `--css=<file>`, `--html=<path or URL>`, `--size=1920x1080,320x256@4` (window sizes for `--html` pages), `--json`. |
| `pnpm ui:report`                               | Every kit's baselines beside the mockups, per state and theme, in `.out/report/index.html`; the React/elements pixel diff once both exist.                                                                                                                                                                    |
| `node packages/ui-qa/bin/kit-lint.mjs --kit=…` | The SwiftUI, Compose, Godot, Qt, React and Node terminal source rules, with no install (each kit's CI lane runs it).                                                                                                                                                                                          |
| `pnpm --filter @polaris-key/ui-qa test:e2e`    | The lint's browser suites: a seeded violation for each rule, and the boards clean.                                                                                                                                                                                                                            |

## Work on it

<!-- work-on-it:start (generated by `pnpm gen readme-work`; do not edit) -->

Run the JavaScript commands under Node 22 (see [`AGENTS.md`](../../AGENTS.md)).

| Command                                                        | Does                                                             |
| -------------------------------------------------------------- | ---------------------------------------------------------------- |
| `pnpm --filter @polaris-key/ui-qa typecheck`                   | Typecheck.                                                       |
| `pnpm --filter @polaris-key/ui-qa test`                        | Run the unit tests.                                              |
| `pnpm --filter @polaris-key/ui-qa test:e2e`                    | Run the lint's browser suites.                                   |
| `pnpm --filter @polaris-key/ui-qa exec vitest run <test file>` | Run one test file (the path is relative to the package).         |
| `pnpm ui:lint`                                                 | Run the modernity, string and kit-source lints (needs Chromium). |
| `pnpm ui:report`                                               | Render the UI kits side by side per state.                       |

Generator families that read or write files here (a family regenerates with `pnpm gen <family>`, and `pnpm gen --check` is the drift gate):

| Family           | Here it          | Run                       |
| ---------------- | ---------------- | ------------------------- |
| `constants`      | reads            | `pnpm gen constants`      |
| `docs-reference` | reads            | `pnpm gen docs-reference` |
| `readme-work`    | reads and writes | `pnpm gen readme-work`    |
| `parity`         | reads            | `pnpm gen parity`         |

<!-- work-on-it:end -->

## Rules here

Rules live in [AGENTS.md](../../AGENTS.md).

- Terminology comes from the concepts page.
- The modernity lint is enforced by `pnpm ui:lint`.
- Every rule exception in `rules/` carries its reason.

## Docs

- [UI-KITS.md](../../docs/design/UI-KITS.md)
- [Review checklist](../../docs/design/ui-kits/REVIEW.md)
