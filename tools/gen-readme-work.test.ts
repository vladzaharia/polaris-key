import { describe, expect, it } from "vitest";
import { familiesFor } from "./gen-readme-work.js";

describe("readme-work family ownership", () => {
  it("includes the brace-glob package targets as readers and writers", () => {
    for (const dir of [
      "packages/worker",
      "packages/admin",
      "packages/docs",
      "packages/elements",
      "packages/ui-qa",
    ])
      expect(
        familiesFor(dir).find((row) => row.family.id === "readme-work")
          ?.relation,
        dir,
      ).toBe("reads and writes");
  });
});
