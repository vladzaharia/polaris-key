/** Types for `ci-scope.mjs` (the one CI scope shared by ci.yml and `pnpm gate` (tools/gate.mjs), P0-43). */

export interface CiScope {
  shared: string[];
  lanes: Record<string, { paths: string[] }>;
  matrices: Record<string, { pr: unknown; main: unknown }>;
}
export declare const SCOPE_FILE: string;
export declare function loadScope(file?: string): CiScope;
export declare function selectLanes(
  scope: CiScope,
  files: string[] | null,
): Record<string, boolean>;
export declare function matrixFor(
  scope: CiScope,
  name: string,
  narrow: boolean,
): unknown;
export declare function ciOutputs(
  scope: CiScope,
  input: { event: string; files: string[] | null },
): Record<string, string>;
export declare function changedFiles(opts: {
  base: string;
  head?: string;
  worktree?: boolean;
  cwd?: string;
}): string[] | null;
