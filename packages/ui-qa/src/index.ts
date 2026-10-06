// Public entry for kits' component tests (UI-KITS.md §7.3): `prepare()` the page, open it, then
// `lintPage()` it. `lintTargets()` and `serveDir()` are what `pnpm ui:lint` drives itself.
export {
  LINT_SCRIPT,
  cssPageUrl,
  fileUrl,
  lintPage,
  lintTargets,
  prepare,
  serveDir,
} from "./run.ts";
export type { PageTarget, TargetResult } from "./run.ts";
export type {
  LintOptions,
  LintResult,
  Violation,
  VisibleString,
} from "./types.ts";
