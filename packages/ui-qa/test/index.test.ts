import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as uiQa from "../src/index.ts";

describe("the package entry kits import (@polaris-key/ui-qa)", () => {
  it("exists where package.json exports it and exposes lintPage/prepare", () => {
    const pkg = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8"),
    ) as { exports: { ".": string } };
    expect(
      existsSync(resolve(import.meta.dirname, "..", pkg.exports["."])),
    ).toBe(true);
    for (const fn of ["lintPage", "prepare", "lintTargets", "serveDir"])
      expect(typeof (uiQa as Record<string, unknown>)[fn]).toBe("function");
  });
});
