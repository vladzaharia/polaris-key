// ui-core is the headless layer: no DOM, no React, no Lit, no framework (the brief's acceptance).
// The compiler holds the DOM out (the package's `lib` has no DOM, so `document` does not even
// type-check); this test holds out every import of a UI framework, and DOM globals reached
// around the types.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const PKG = join(import.meta.dirname, "..");
const SRC = join(PKG, "src");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}

const FRAMEWORKS =
  /^(react|react-dom|react-native|preact|lit|lit-html|lit-element|@lit\/.*|@lit-labs\/.*|vue|svelte|@angular\/.*|solid-js|jsdom|happy-dom)(\/.*)?$/;
const DOM_GLOBALS =
  /\b(document|window|navigator|HTMLElement|customElements|localStorage|sessionStorage|requestAnimationFrame|matchMedia)\s*[.([]/;

describe("no DOM, React or Lit in @polaris-key/ui-core", () => {
  const sources = files(SRC).map((f) => ({
    file: relative(PKG, f),
    text: readFileSync(f, "utf8"),
  }));

  it("imports no UI framework", () => {
    for (const { file, text } of sources)
      for (const m of text.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g))
        expect(FRAMEWORKS.test(m[1]!), `${file} imports ${m[1]}`).toBe(false);
  });

  it("reaches for no DOM global", () => {
    for (const { file, text } of sources) {
      const code = text
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*)/.test(l))
        .join("\n");
      expect(DOM_GLOBALS.exec(code)?.[0], file).toBeUndefined();
    }
  });

  it("compiles without the DOM library, and depends on no framework", () => {
    const tsconfig = JSON.parse(
      readFileSync(join(PKG, "tsconfig.json"), "utf8"),
    ) as {
      compilerOptions: { lib: string[] };
    };
    expect(
      tsconfig.compilerOptions.lib.map((l) => l.toLowerCase()),
    ).not.toContain("dom");
    const pkg = JSON.parse(
      readFileSync(join(PKG, "package.json"), "utf8"),
    ) as Record<string, Record<string, string> | undefined>;
    const deps = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
    ];
    for (const d of deps) expect(FRAMEWORKS.test(d), d).toBe(false);
    // The main entry needs no brand: the Node terminal imports it without one.
    expect(pkg.peerDependenciesMeta).toEqual({
      "@polaris-key/brand": { optional: true },
    });
    for (const { file, text } of sources)
      if (!file.startsWith("src/theme/"))
        expect(text.includes('"@polaris-key/brand'), file).toBe(false);
  });
});
