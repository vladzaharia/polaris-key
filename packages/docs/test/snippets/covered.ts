/**
 * The pages whose blocks and named symbols must hold (SP-45a's pages, and every page a later work
 * package adds here). Every other source is advisory: its failures are recorded in
 * `advisory-baseline.json` and may only shrink.
 */

export interface Covered {
  /** Repo-relative path, or a directory prefix ending in `/`. */
  path: string;
  language: "ts" | "python";
}

export const COVERED_PAGES: Covered[] = [];

export function coveredLanguage(file: string): "ts" | "python" | null {
  const hit = COVERED_PAGES.find((c) =>
    c.path.endsWith("/") ? file.startsWith(c.path) : file === c.path,
  );
  return hit?.language ?? null;
}
