/**
 * A syntax error in an Expressive Code script silently kills every Copy button and the tabindex
 * module bundled with it. Parse the source module and every built ec bundle.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COPY_MODULE } from "../ec.config.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const parses = (src: string): void => {
  // Compile only: wrapping in a function body parses it without running it.
  new Function(src);
};

describe("Expressive Code scripts", () => {
  it("the Copy module parses and carries its escapes literally", () => {
    expect(() => parses(COPY_MODULE)).not.toThrow();
    expect(COPY_MODULE).toContain("\\u007f");
    expect(COPY_MODULE).not.toContain("\u007f");
  });

  const assets = join(root, "dist", "_astro");
  const bundles = existsSync(assets)
    ? readdirSync(assets).filter((f) => /^ec\..*\.js$/.test(f))
    : [];
  it.skipIf(bundles.length === 0)("every built ec bundle parses", () => {
    for (const f of bundles)
      expect(
        () => parses(readFileSync(join(assets, f), "utf8")),
        f,
      ).not.toThrow();
  });
});
