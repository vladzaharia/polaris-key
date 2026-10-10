import { describe, expect, it } from "vitest";
import { extractRegion } from "../src/lib/snippet";
import { splitSections, slugifyHeading } from "../src/lib/runbook";

const SOURCE = `import PolarisKey
// docs:start gate
let gate = try await client.gate()
if gate.allowed {
    run()
}
// docs:end gate
// docs:start other
let other = 1
// docs:end other
`;

describe("extractRegion", () => {
  it("returns the lines between the markers, without them", () => {
    expect(extractRegion(SOURCE, "gate")).toBe(
      "let gate = try await client.gate()\nif gate.allowed {\n    run()\n}",
    );
  });

  it("hides setup lines outside the region", () => {
    expect(extractRegion(SOURCE, "gate")).not.toContain("import PolarisKey");
  });

  it("handles # comments and dedents", () => {
    const py =
      "x = 1\n# docs:start main\n    if ok:\n        run()\n# docs:end main\n";
    expect(extractRegion(py, "main")).toBe("if ok:\n    run()");
  });

  it("without a region returns the file minus its markers", () => {
    expect(extractRegion(SOURCE)).not.toContain("docs:");
    expect(extractRegion(SOURCE)).toContain("import PolarisKey");
  });

  it("fails loudly on a missing region", () => {
    expect(() => extractRegion(SOURCE, "nope")).toThrow(/no "docs:start nope"/);
  });
});

describe("runbook sections", () => {
  const md =
    "# Title\n\nintro\n\n## Rotate the KEK\n\nsteps\n\n```sh\n## not a heading\n```\n\n## Verify\n\nok\n";

  it("splits at H2, ignoring code fences", () => {
    const parts = splitSections(md);
    expect(parts.map((p) => p.heading)).toEqual(["Rotate the KEK", "Verify"]);
    expect(parts[0]!.body).toContain("## not a heading");
    expect(parts[1]!.body).toBe("ok");
  });

  it("slugifies a heading", () => {
    expect(slugifyHeading("Rotate the KEK (production)")).toBe(
      "rotate-the-kek-production",
    );
  });
});
