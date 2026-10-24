/**
 * Checks that the repo paths and `pnpm` commands a text cites exist. Shared by the
 * instruction-file test (`agents-md.test.ts`) and `skills-check.ts`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const packageScripts = (dir: string): Record<string, string> => {
  const file = join(ROOT, dir, "package.json");
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, "utf8")).scripts ?? {};
};

export const packageDirs = (): Map<string, string> => {
  const out = new Map<string, string>();
  for (const parent of ["packages", "tools", "products", "conformance"]) {
    const candidates = [parent];
    for (const entry of existsSync(join(ROOT, parent))
      ? execFileSync("ls", [join(ROOT, parent)])
          .toString()
          .split("\n")
      : []) {
      if (entry) candidates.push(`${parent}/${entry}`);
    }
    for (const dir of candidates) {
      const file = join(ROOT, dir, "package.json");
      if (!existsSync(file)) continue;
      const name = JSON.parse(readFileSync(file, "utf8")).name;
      if (typeof name === "string") out.set(name, dir);
    }
  }
  return out;
};

export const generatorFamilies = (): Set<string> =>
  new Set(
    [
      ...readFileSync(join(ROOT, "tools/generators.ts"), "utf8").matchAll(
        /^\s*id:\s*"([^"]+)"/gm,
      ),
    ].map((match) => match[1] as string),
  );

export const looksLikePath = (token: string): boolean => {
  if (/\s|[<>*{}|$:]|^@|^-|^\.\.\.|…/.test(token)) return false;
  if (/^~|^\/|\$/.test(token)) return false;
  return token.includes("/") || /\.(md|ts|mjs|json|yaml|sh)$/.test(token);
};

/**
 * The backticked spans that look like repo paths and resolve nowhere. A path resolves when it
 * exists under the repo root, under one of `bases`, or under `dir` (all relative to the root).
 */
export function missingPaths(
  spans: readonly string[],
  opts: {
    dir: string;
    bases: readonly string[];
    absent?: ReadonlySet<string>;
  },
): string[] {
  return spans
    .filter(looksLikePath)
    .map((token) => token.replace(/[.,;:]+$/, "").replace(/\/+$/, ""))
    .filter((token) => !opts.absent?.has(token))
    .filter(
      (token) =>
        !opts.bases.some((base) => existsSync(join(ROOT, base, token))) &&
        !existsSync(join(ROOT, opts.dir, token)),
    );
}

/** The backticked `pnpm ...` spans naming a script, filter or generator family that is not there. */
export function missingPnpmScripts(
  spans: readonly string[],
  dir: string,
): string[] {
  const families = generatorFamilies();
  const packages = packageDirs();
  const bad: string[] = [];
  for (const span of spans) {
    const filtered = span.match(/^pnpm --filter (\S+) (?:run )?([\w:.-]+)/);
    if (filtered && filtered[2] === "exec") continue;
    if (filtered) {
      const pkgDir = packages.get(filtered[1] as string);
      const script = filtered[2] as string;
      if (!pkgDir || !(script in packageScripts(pkgDir))) bad.push(span);
      continue;
    }
    const gen = span.match(/^pnpm gen(?: ([a-z][\w-]*))?/);
    if (gen) {
      if (gen[1] && !families.has(gen[1])) bad.push(span);
      continue;
    }
    const plain = span.match(/^pnpm (?:run )?([\w:.-]+)/);
    if (plain) {
      const script = plain[1] as string;
      const builtin = ["install", "exec", "add", "audit", "dlx", "turbo"];
      if (
        !builtin.includes(script) &&
        !(script in packageScripts(".")) &&
        !(script in packageScripts(dir))
      ) {
        bad.push(span);
      }
    }
  }
  return bad;
}
