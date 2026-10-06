// The per-kit source lints, re-exported for `pnpm ui:lint` (the implementation is zero-dependency
// plain Node in bin/kit-lint.mjs so the kits' own CI lanes can run it without an install).
export {
  lintKits,
  record as recordKitDebt,
  scan as scanKits,
  type KitHit as KitFinding,
} from "../bin/kit-lint.mjs";
