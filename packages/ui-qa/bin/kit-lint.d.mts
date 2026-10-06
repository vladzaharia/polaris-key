export interface KitHit {
  kit: string;
  rule: string;
  file: string;
  line: number;
  text: string;
  detail: string;
}
export interface KitLintOptions {
  rulesFile?: string;
  debtFile?: string;
}
export const DEFAULT_ROOT: string;
export function scan(
  root?: string,
  kits?: string[] | null,
  rulesFile?: string,
): KitHit[];
export function lintKits(
  root?: string,
  kits?: string[] | null,
  opts?: KitLintOptions,
): { hits: KitHit[]; findings: KitHit[] };
export function record(
  root?: string,
  opts?: KitLintOptions,
): Array<{ kit: string; rule: string; file: string; count: number }>;
