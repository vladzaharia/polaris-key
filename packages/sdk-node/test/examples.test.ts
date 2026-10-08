// SDK parity pass SP-N18: the samples in `examples/node-*` (and the terminal kit's sample,
// `examples/ui/terminal-node`) install the SDK from the feed, so CI does not build them; this
// test keeps them honest instead. Every value a sample imports from
// `@polaris-key/node` (or a subpath) must be exported by that subpath, resolved through this
// package's `exports` map exactly as a consumer would see it.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const examples = join(pkgRoot, "..", "..", "examples");
const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as {
  exports: Record<string, { default: string }>;
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (name === "node_modules") return [];
    return statSync(p).isDirectory()
      ? files(p)
      : /\.(ts|tsx)$/.test(name)
        ? [p]
        : [];
  });
}

/** `import { a, type B, c as d } from "@polaris-key/node/x"` → value names per specifier. */
function valueImports(src: string): { spec: string; names: string[] }[] {
  const out: { spec: string; names: string[] }[] = [];
  const re =
    /import\s+(type\s+)?\{([^}]*)\}\s+from\s+"(@polaris-key\/node[^"]*)"/g;
  for (const m of src.matchAll(re)) {
    if (m[1]) continue;
    const names = m[2]!
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith("type "))
      .map((s) => s.split(/\s+as\s+/)[0]!.trim());
    out.push({ spec: m[3]!, names });
  }
  return out;
}

const samples = files(examples).filter((f) =>
  /^(node-|ui\/terminal-node\/)/.test(relative(examples, f)),
);

describe("examples/node-* and examples/ui/terminal-node import only what the SDK exports", () => {
  it("has samples to check", () => {
    expect(samples.length).toBeGreaterThanOrEqual(4);
  });

  for (const file of samples) {
    it(relative(examples, file), async () => {
      for (const { spec, names } of valueImports(readFileSync(file, "utf8"))) {
        const sub = `.${spec.slice("@polaris-key/node".length)}`;
        const target = pkg.exports[sub];
        expect(target, `${spec} is not in package.json exports`).toBeDefined();
        const srcPath = join(
          pkgRoot,
          target!.default
            .replace(/^\.\/dist\//, "src/")
            .replace(/\.js$/, ".ts"),
        );
        const mod = (await import(srcPath)) as Record<string, unknown>;
        for (const n of names)
          expect(mod[n], `${spec} has no export ${n}`).toBeDefined();
      }
    });
  }
});
