/** Types for `ci-js-affected.mjs` (which JS test jobs a green-base diff leaves with work). */
export declare function packagesOf(dryRunText: string): Set<string>;
export declare function affected(
  pkg: string,
  base: string | undefined,
  run?: (args: string[]) => string,
): boolean;
