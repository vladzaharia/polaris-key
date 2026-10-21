/**
 * No local restyling (docs plan 8.5): a part the console has is drawn with the console's own
 * class constants, and no docs stylesheet re-decides its colour, radius, spacing or type size.
 *
 * - no docs source writes a class string that `ui/classes.ts` holds;
 * - no docs stylesheet or `.astro` style block sets colour, radius, spacing or font size on the
 *   classes the rendered console components and the shared parts carry.
 *
 * Starlight-only parts are not on the list: they are not console parts.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as classes from "../../admin/src/ui/classes";

const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function* files(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* files(full);
    else yield full;
  }
}
const all = [...files(src)];
const sources = all.filter((f) => /\.(astro|ts|tsx|mdx)$/.test(f));
const styles = all.filter((f) => f.endsWith(".css"));

/** Every class string the constants hold, flattened (whole strings of 12+ characters). */
function constantStrings(): string[] {
  const out: string[] = [];
  const visit = (v: unknown): void => {
    if (typeof v === "string") {
      if (v.length >= 12) out.push(v);
    } else if (v && typeof v === "object") Object.values(v).forEach(visit);
  };
  visit(classes);
  return out;
}

/** Classes the rendered console components and the shared parts carry in the docs. */
const GUARDED = [
  "pk-callout",
  "pk-pill",
  "pk-status",
  "pk-chip",
  "pk-requires",
  "pk-console-link",
  "pk-portal-link",
  "pk-code-frame",
];
const PROPERTY =
  /^(color|background(-color)?|border(-[a-z]+)*-radius|border-radius|padding(-[a-z]+)*|margin(-[a-z]+)*|font-size|gap)$/;

/** The rule bodies of a stylesheet whose selector mentions a guarded class. */
function guardedDeclarations(css: string): string[] {
  const hits: string[] = [];
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const rule of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = rule[1]!;
    if (!GUARDED.some((c) => selector.includes(`.${c}`))) continue;
    for (const decl of rule[2]!.split(";")) {
      const prop = decl.split(":")[0]?.trim();
      if (prop && PROPERTY.test(prop))
        hits.push(`${selector.trim()} { ${prop} }`);
    }
  }
  return hits;
}

describe("docs classes", () => {
  it("the constants exist and are non-trivial", () => {
    expect(constantStrings().length).toBeGreaterThan(10);
  });

  it("no docs source writes a class string the console constants hold", () => {
    const strings = constantStrings();
    const offenders: string[] = [];
    for (const file of sources) {
      const text = readFileSync(file, "utf8");
      for (const s of strings)
        if (text.includes(s)) offenders.push(`${file}: ${s.slice(0, 40)}`);
    }
    expect(offenders).toEqual([]);
  });

  it("no docs stylesheet restyles a guarded class", () => {
    const offenders: string[] = [];
    for (const file of styles)
      for (const h of guardedDeclarations(readFileSync(file, "utf8")))
        offenders.push(`${file}: ${h}`);
    for (const file of all.filter((f) => f.endsWith(".astro"))) {
      for (const block of readFileSync(file, "utf8").matchAll(
        /<style[^>]*>([\s\S]*?)<\/style>/g,
      ))
        for (const h of guardedDeclarations(block[1]!))
          offenders.push(`${file}: ${h}`);
    }
    expect(offenders).toEqual([]);
  });
});
