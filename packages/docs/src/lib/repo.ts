/**
 * The repository root and existence checks against it, for build-time facts a page states
 * (whether a kit's sample folder exists yet). Pages render at build time in Node, from the docs
 * package or the repository root, so the root is found by walking up to pnpm-workspace.yaml.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

let cached: string | null = null;

export function repoRoot(from: string = process.cwd()): string {
  if (cached !== null) return cached;
  let dir = resolve(from);
  while (!existsSync(join(dir, "pnpm-workspace.yaml"))) {
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`repoRoot: no pnpm-workspace.yaml above ${from}`);
    }
    dir = parent;
  }
  cached = dir;
  return dir;
}

/** True when the repository-relative path exists. */
export function repoHas(path: string): boolean {
  return existsSync(join(repoRoot(), path));
}
