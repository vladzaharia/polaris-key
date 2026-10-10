/**
 * The MDX components (docs plan section 8.3): the registry, the files and the props agree, and
 * the page that documents them renders them. Props are the contract; styling is DOC-02a's.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DOCS_COMPONENTS } from "../src/components/docs/index";
import { SDK_IDS, LANE_IDS } from "../src/lib/docs";

const components = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "components",
  "docs",
);
const EXPECTED = [
  "SdkPicker",
  "Lanes",
  "Generated",
  "Snippet",
  "InstallSteps",
  "StatesToHandle",
  "Steps",
  "Callout",
  "Pill",
  "Status",
  "FeatureCard",
  "CardGrid",
  "PortalShot",
  "KitBaselines",
  "HelpMessage",
  "UiLabel",
  "ConsoleLink",
  "PortalLink",
  "Requires",
  "RunbookSection",
];

describe("docs components", () => {
  it("are exactly the plan's list", () => {
    expect(DOCS_COMPONENTS.map((c) => c.name).sort()).toEqual(
      [...EXPECTED].sort(),
    );
  });

  it("each has a file with a Props contract naming every registered prop", () => {
    for (const c of DOCS_COMPONENTS) {
      const file = join(components, c.file);
      expect(existsSync(file), c.file).toBe(true);
      const source = readFileSync(file, "utf8");
      expect(source, `${c.name}: Props`).toMatch(
        /(export )?(interface|type) Props/,
      );
      for (const prop of c.props) {
        if (prop.startsWith("slot")) continue;
        const name = /^(\w+)\??:/.exec(prop)?.[1];
        if (name === undefined) continue;
        expect(source, `${c.name}.${name}`).toContain(name);
      }
    }
  });

  it("registers a summary for each", () => {
    for (const c of DOCS_COMPONENTS)
      expect(c.summary.length, c.name).toBeGreaterThan(10);
  });

  it("the pickers cover every SDK and both lanes", () => {
    expect(SDK_IDS).toHaveLength(6);
    expect([...LANE_IDS]).toEqual(["kit", "library"]);
  });

  it("the contributor page uses every component that renders without data", () => {
    const page = readFileSync(
      join(
        components,
        "..",
        "..",
        "content",
        "docs",
        "contribute",
        "docs-components.mdx",
      ),
      "utf8",
    );
    for (const name of [
      "SdkPicker",
      "Lanes",
      "Callout",
      "Pill",
      "Status",
      "FeatureCard",
      "CardGrid",
      "Requires",
      "StatesToHandle",
      "HelpMessage",
      "UiLabel",
      "ConsoleLink",
      "PortalLink",
    ])
      expect(page, name).toContain(`<${name}`);
  });
});
