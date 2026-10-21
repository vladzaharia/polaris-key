/** Help titles use the curly apostrophe its body uses (B-167). */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { allIds, fileFor, splitFrontmatter } from "../scripts/site-map.mjs";

describe("Help page titles", () => {
  it("hold no straight apostrophe", () => {
    const bad = allIds()
      .filter((id) => id.startsWith("help/"))
      .filter((id) => {
        const { data } = splitFrontmatter(readFileSync(fileFor(id)!, "utf8"));
        return String((data as { title?: unknown }).title ?? "").includes("'");
      });
    expect(bad).toEqual([]);
  });
});
