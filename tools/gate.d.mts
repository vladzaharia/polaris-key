/** Types for `gate.mjs` (`pnpm gate`, AX-04). */

import type { CiScope } from "./ci-scope.mjs";

export interface GateContext {
  root: string;
  mergeBase: string | null;
  files: string[] | null;
  /** Changed files that still exist (what prettier can check). */
  existing: string[];
  full: boolean;
}
export interface GateStep {
  n: number;
  id: string;
  title: string;
  /** A ci-scope.json lane, or null for a step that always runs. */
  lane: string | null;
  cwd?: string;
  heavy?: boolean;
  slot?: boolean;
  fullOnly?: boolean;
  pre?: (root: string, run: (argv: string[]) => unknown) => void;
  argv(ctx: GateContext): string[] | null;
  argvFull?(ctx: GateContext): string[] | null;
}
export interface PlannedStep extends GateStep {
  run: boolean;
  reason: string;
}
export interface GateFlags {
  dir?: string;
  base?: string;
  full: boolean;
  only: number[];
  from?: number;
  plan: boolean;
  help: boolean;
}
export interface GateIo {
  run(
    argv: string[],
    opts: { cwd: string },
  ): { status: number; output: string };
  log(line: string): void;
  acquire?(): void;
  release?(): void;
}
export declare const STEPS: GateStep[];
export declare const LOCAL_LANES: string[];
export declare function parseFlags(
  argv: string[],
  env?: Record<string, string | undefined>,
): GateFlags;
export declare function stepNumber(s: string): number;
export declare function plan(
  files: string[] | null,
  flags?: Partial<GateFlags>,
  scope?: CiScope,
): { steps: PlannedStep[]; lanes: Record<string, boolean> };
export declare function ciAlsoRuns(lanes: Record<string, boolean>): string[];
export declare function commandFor(
  step: GateStep,
  ctx: GateContext,
  env?: Record<string, string | undefined>,
): string[] | null;
export declare function runSteps(
  planned: PlannedStep[],
  ctx: GateContext,
  io: GateIo,
  env?: Record<string, string | undefined>,
): number;
export declare function mergeBaseOf(root: string, base?: string): string | null;
export declare function changedSince(
  root: string,
  mergeBase: string | null,
): string[] | null;
export declare function slotPool(
  max: number,
  dir?: string,
): { acquire(): void; release(): void };
export declare function main(
  argv: string[],
  env?: Record<string, string | undefined>,
): number;
