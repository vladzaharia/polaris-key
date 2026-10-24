/** Types for `lint-debt.mjs` (the lint-debt ledger mechanism, P0-46.1). */

export interface Finding {
  file: string;
  rule: string;
}
export interface Adapter {
  parse(text: string, ctx: { root: string }): Finding[];
}
export type Debt = Record<string, Record<string, number>>;
export interface Ledger {
  $comment?: string;
  version: 1;
  debt: Debt;
}
export interface Drift {
  file: string;
  rule: string;
  have: number;
  ledger: number;
}
export declare class LintDebtError extends Error {}
export declare function globToRegExp(glob: string): RegExp;
export declare function loadGenerated(path?: string): RegExp[];
export declare function excluded(file: string, generated?: RegExp[]): boolean;
export declare function loadAdapter(tool: string): Promise<Adapter>;
export declare function findingsOf(
  tool: string,
  adapter: Adapter,
  text: string,
  root: string,
  generated: RegExp[],
): Finding[];
export declare function tally(findings: Finding[]): Debt;
export declare function readLedger(path: string): Ledger;
export declare function diff(
  tool: string,
  findings: Finding[],
  ledger: Ledger,
): { added: Drift[]; cleared: Drift[] };
export declare function recorded(
  tool: string,
  findings: Finding[],
  ledger: Ledger,
): Ledger;
export declare function run(
  argv: string[],
  stdin?: () => string,
): Promise<{ code: number; out: string[] }>;
