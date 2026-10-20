// LK-03 (plans/LK-00.md §7.2): `customerOrigin()` is the ONE source of every customer URL. This
// scans the Worker's source for a customer path literal (`/#/p/`, `/activate`, `/signin`,
// `/device`, `/tv`, `/magic/verify`) built on an origin that did not come from it.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const LITERAL =
  /\$\{([^}]*)\}(\/#\/p\/|\/activate|\/signin|\/device\b|\/tv\b|\/magic\/verify)/g;

/** Origins the builders may use: the resolved customer origin, or a parameter that carries one. */
const OK_ORIGIN =
  /^(origin|customer|input\.origin|customerOrigin\([^)]*\) \?\? new URL\(req\.url\)\.origin)$/;

/** Sites that stay on the request's origin on purpose, each with the package that moves it. */
const ALLOWED: Record<string, string> = {};

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? files(join(dir, e.name))
      : e.name.endsWith(".ts")
        ? [join(dir, e.name)]
        : [],
  );
}

describe("customer URLs come from customerOrigin()", () => {
  it("no customer path is built on another origin", () => {
    const bad: string[] = [];
    for (const file of files(SRC)) {
      const rel = relative(SRC, file);
      if (rel in ALLOWED) continue;
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(LITERAL))
        if (!OK_ORIGIN.test(m[1]!.trim()))
          bad.push(`${rel}: \${${m[1]}}${m[2]}`);
    }
    expect(bad).toEqual([]);
  });
});
