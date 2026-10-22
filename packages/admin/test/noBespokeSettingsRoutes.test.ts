// ST-05b: the console calls only the generic settings routes. The four bespoke routes it used
// (`update/settings`, `license/policy`, `trust-policy`, `distribution/access`) are gone from the
// Worker, so a client call left on one of them would be a 404 the operator meets as an empty page.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src", "api.ts");

describe("the console's API client", () => {
  const source = readFileSync(SRC, "utf8");

  it.each([
    "/update/settings",
    "/license/policy",
    "/trust-policy",
    "/distribution/access",
  ])("makes no call to the retired route %s", (path) => {
    // A request path is a template or string literal; a comment may still name the route.
    const calls = source
      .split("\n")
      .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//"))
      .filter((l) => l.includes(path));
    expect(calls).toEqual([]);
  });
});
