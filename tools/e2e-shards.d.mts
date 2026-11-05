export const E2E_DIR: string;
export const TIMINGS_FILE: string;
export const FORKS: number;
export function e2eFiles(dir?: string): string[];
export function loadTimings(file?: string): Record<string, number>;
export function costOf(file: string, timings: Record<string, number>): number;
export function assign(
  files: string[],
  count: number,
  timings: Record<string, number>,
): { files: string[]; load: number }[];
export function problems(
  files: string[],
  shards: { files: string[]; load: number }[],
  timings: Record<string, number>,
): string[];
