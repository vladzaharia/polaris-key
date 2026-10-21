/**
 * MDX goes in `.mdx` files. A `.md` page renders `import` lines and component tags as text
 * (B-159: /docs/build/ printed three imports and none of its cards).
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { allIds, fileFor } from "../scripts/site-map.mjs";

describe("markdown pages", () => {
  it("hold no MDX import or component tag outside a fence", () => {
    const bad: string[] = [];
    for (const id of allIds()) {
      const file = fileFor(id)!;
      if (!file.endsWith(".md")) continue;
      let fence = false;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (/^\s*(```|~~~)/.test(line)) fence = !fence;
          else if (
            !fence &&
            /^(import\s.+from\s|<[A-Z][A-Za-z]*[\s/>])/.test(line)
          )
            bad.push(`${id}:${i + 1}`);
        });
    }
    expect(bad).toEqual([]);
  });
});
