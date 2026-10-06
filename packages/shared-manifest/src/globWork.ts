/**
 * A work counter for `matchesArtifactGlob` (index.ts), a test hook kept out of the package's
 * entry point (P1-13's pattern): every step of the matcher's loop adds one. The pathological-glob
 * check diffs it around a call instead of reading a clock, so it holds under any load.
 */
export const globWork = { steps: 0 };
