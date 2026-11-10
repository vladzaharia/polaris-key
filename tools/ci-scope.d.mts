/** Types for `ci-scope.mjs` (the one CI scope shared by ci.yml and `pnpm gate` (tools/gate.mjs), P0-43). */

export interface CiScope {
  shared: string[];
  lanes: Record<string, { paths: string[] }>;
  matrices: Record<string, { pr: unknown; main: unknown }>;
  /** Job display-name globs per lane, `js` and `always`. */
  jobs: Record<string, string[]>;
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
export interface PushScope {
  /** Each tracked group's green base (a SHA), null when it has none. */
  bases: Record<string, string | null>;
  /** The files changed since that base, null when unknown. */
  files: Record<string, string[] | null>;
}
export declare function ciOutputs(
  scope: CiScope,
  input: {
    event: string;
    ref?: string;
    files?: string[] | null;
    push?: PushScope | null;
  },
): Record<string, string>;
export declare function changedFiles(opts: {
  base: string;
  head?: string;
  worktree?: boolean;
  cwd?: string;
}): string[] | null;
export declare const NEXT_REF: string;
export declare const ANCESTRY_LIMIT: number;
export declare const RUN_LIMIT: number;
export interface CiJob {
  name: string;
  conclusion: string;
}
export declare function globMatch(glob: string, name: string): boolean;
export declare function groupOfJob(scope: CiScope, name: string): string | null;
export declare function trackedGroups(scope: CiScope): string[];
export declare function greenGroups(
  scope: CiScope,
  jobs: CiJob[],
): Record<string, boolean>;
export declare function laneBases(
  scope: CiScope,
  commits: string[],
  jobsOf: (sha: string) => CiJob[] | null,
): Record<string, string | null>;
export declare function greenBasesOf(opts: {
  scope: CiScope;
  repo: string;
  head?: string;
  cwd?: string;
  run?: (cmd: string, args: string[]) => string;
}): Record<string, string | null> | null;
