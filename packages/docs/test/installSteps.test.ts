/**
 * `<InstallSteps sdk=…>` (docs plan section 4): the install lines on every page come from the
 * CLI's own `feedsSetup()`. This pins the component's `FEEDS` mapping, `sdk="cli"` included,
 * against that function's output, so a renamed package or a changed feed shows here first.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { feedsSetup } from "../../cli/src/feedSetup";
import { DOCS_COMPONENTS } from "../src/components/docs/index";
import { SDK_IDS } from "../src/lib/docs";
import { FEEDS, INSTALL_LABELS, type InstallTarget } from "../src/lib/feeds";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p: string[]) => readFileSync(join(here, "..", ...p), "utf8");

const TARGETS: InstallTarget[] = [...SDK_IDS, "cli"];

interface Snippet {
  id: string;
  title: string;
  filename?: string;
  language: string;
  code: string;
}

/** Exactly what the component asks of `feedsSetup()`. */
function render(target: InstallTarget): {
  ecosystem: string;
  snippets: Snippet[];
} {
  const feed = FEEDS[target];
  return JSON.parse(
    feedsSetup({
      ecosystem: feed.ecosystem,
      owner: "polaris-key",
      namespace: feed.namespace,
      package: feed.package,
      json: true,
    }),
  );
}

/** The package and ecosystem each target must install, from the SDKs' own manifests. */
const EXPECTED: Record<InstallTarget, { ecosystem: string; package: string }> =
  {
    node: { ecosystem: "npm", package: "@polaris-key/node" },
    react: { ecosystem: "npm", package: "@polaris-key/react" },
    python: { ecosystem: "pypi", package: "polaris-key" },
    swift: { ecosystem: "swift", package: "polaris-key.PolarisKey" },
    kotlin: { ecosystem: "maven", package: "im.plrs.key:polaris-key-sdk" },
    godot: { ecosystem: "godot", package: "polaris_key" },
    cli: { ecosystem: "npm", package: "@polaris-key/cli" },
  };

describe("InstallSteps FEEDS mapping", () => {
  it("covers every SDK and the CLI, and nothing else", () => {
    expect(Object.keys(FEEDS).sort()).toEqual([...TARGETS].sort());
    expect(Object.keys(INSTALL_LABELS).sort()).toEqual([...TARGETS].sort());
  });

  it("the component takes sdk: SdkId | 'cli' and the registry says so", () => {
    const source = read("src/components/docs/InstallSteps.astro");
    expect(source).toMatch(/sdk: InstallTarget/);
    expect(source).toMatch(/from "\.\.\/\.\.\/lib\/feeds"/);
    expect(source).toMatch(
      /from "\.\.\/\.\.\/\.\.\/\.\.\/cli\/src\/feedSetup"/,
    );
    const registered = DOCS_COMPONENTS.find((c) => c.name === "InstallSteps");
    expect(registered?.props).toEqual(['sdk: SdkId | "cli"']);
  });

  it("the cli target installs @polaris-key/cli, the package the CLI is published as", () => {
    const manifest = JSON.parse(read("..", "cli", "package.json")) as {
      name: string;
      bin?: Record<string, string>;
    };
    expect(FEEDS.cli.package).toBe(manifest.name);
    expect(Object.keys(manifest.bin ?? {})).toContain("pkey");
    expect(INSTALL_LABELS.cli).toBe("the pkey CLI");
  });

  for (const target of TARGETS) {
    describe(target, () => {
      it("names the expected ecosystem and package", () => {
        expect(FEEDS[target].ecosystem).toBe(EXPECTED[target].ecosystem);
        expect(FEEDS[target].package).toBe(EXPECTED[target].package);
      });

      it("is accepted by feedsSetup() and renders the ecosystem's snippets", () => {
        const { ecosystem, snippets } = render(target);
        expect(ecosystem).toBe(EXPECTED[target].ecosystem);
        expect(snippets.length).toBeGreaterThan(0);
        for (const s of snippets) {
          expect(s.title, `${target}/${s.id}`).not.toBe("");
          expect(s.code, `${target}/${s.id}`).not.toBe("");
          expect(s.language, `${target}/${s.id}`).not.toBe("");
        }
      });

      it("routes the package to the Polaris Key feed on pkg.plrs.im", () => {
        const { snippets } = render(target);
        const all = snippets.map((s) => s.code).join("\n");
        expect(all).toContain("https://pkg.plrs.im/");
        expect(all).toContain("/polaris-key");
      });

      it("names the package in an install snippet, except Godot's (the editor installs it)", () => {
        const { snippets } = render(target);
        const named = snippets.some((s) =>
          s.code.includes(EXPECTED[target].package),
        );
        expect(named, `${target}: a snippet names the package`).toBe(
          target !== "godot",
        );
      });
    });
  }

  it("cli renders the npm feed's snippets with the CLI install", () => {
    const { snippets } = render("cli");
    expect(snippets.map((s) => s.id)).toEqual([
      "npmrc",
      "yarn",
      "bun",
      "install",
    ]);
    expect(snippets.find((s) => s.id === "npmrc")?.code).toBe(
      "@polaris-key:registry=https://pkg.plrs.im/npm/polaris-key/",
    );
    expect(snippets.at(-1)).toMatchObject({
      id: "install",
      code: "npm install @polaris-key/cli",
    });
  });

  it("node and react differ from cli only in the install line", () => {
    const cli = render("cli").snippets;
    for (const t of ["node", "react"] as const) {
      const other = render(t).snippets;
      expect(other.slice(0, -1)).toEqual(cli.slice(0, -1));
      expect(other.at(-1)?.code).toBe(`npm install ${FEEDS[t].package}`);
    }
  });

  it("the CLI's own text output carries the same code as the JSON the component reads", () => {
    for (const target of TARGETS) {
      const feed = FEEDS[target];
      const text = feedsSetup({
        ecosystem: feed.ecosystem,
        owner: "polaris-key",
        namespace: feed.namespace,
        package: feed.package,
      });
      for (const s of render(target).snippets)
        expect(text, `${target}/${s.id}`).toContain(s.code);
    }
  });

  it("the install page and the first-product page render the cli install", () => {
    for (const page of ["build/install.mdx", "start/first-product.mdx"])
      expect(read("src/content/docs", page), page).toContain(
        '<InstallSteps sdk="cli" />',
      );
  });

  it("the pip block installs no dependencies, so both pages name the SDK's own", () => {
    const pip = render("python").snippets.find((s) => s.id === "pip");
    expect(pip?.code).toContain("--no-deps");
    const pyproject = readFileSync(
      join(here, "..", "..", "..", "sdks", "python", "pyproject.toml"),
      "utf8",
    );
    const block = /^dependencies = \[([\s\S]*?)^\]/m.exec(pyproject)?.[1] ?? "";
    const want = [
      ...block
        .split("\n")
        .filter((l) => !l.trim().startsWith("#"))
        .join("\n")
        .matchAll(/"([^"]+)"/g),
    ]
      .map((m) => m[1])
      .sort();
    expect(want.map((d) => d?.split(/[>=;]/)[0]?.trim())).toEqual([
      "cryptography",
      "httpx",
      "zstandard",
    ]);
    for (const page of ["build/install.mdx", "start/first-product.mdx"]) {
      const text = read("src/content/docs", page);
      const line = /pip install ("cryptography[^\n`]*)/.exec(text)?.[1] ?? "";
      const got = [...line.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
      expect(got, page).toEqual(want);
    }
  });
});
