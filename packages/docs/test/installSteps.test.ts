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
function ask(target: InstallTarget) {
  const feed = FEEDS[target];
  return {
    ecosystem: feed.ecosystem,
    owner: "polaris-key",
    namespace: feed.namespace,
    package: feed.package,
    ...(feed.version ? { version: feed.version } : {}),
  };
}

function render(target: InstallTarget): {
  ecosystem: string;
  snippets: Snippet[];
} {
  return JSON.parse(feedsSetup({ ...ask(target), json: true }));
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
    expect(registered?.props).toEqual([
      'sdk: SdkId | "cli"',
      "heading?: boolean",
      'dev?: SdkId | "cli"',
    ]);
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
      const text = feedsSetup(ask(target));
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

  it("the Swift block asks for a release that exists: a 0.9 floor, never the generated 1.0.0", () => {
    const line = render("swift").snippets.find((s) => s.id === "package-swift");
    expect(line?.code).toBe(
      '.package(id: "polaris-key.PolarisKey", from: "0.9.0")',
    );
    // Why the version is passed: the generator's own default is a 1.0.0 floor no release matches.
    const bare = feedsSetup({
      ecosystem: "swift",
      owner: "polaris-key",
      namespace: FEEDS.swift.namespace,
      package: FEEDS.swift.package,
    });
    expect(bare).toContain('from: "1.0.0"');
  });

  it("both pages wire the Swift package the way its manifest declares it", () => {
    const pkg = readFileSync(
      join(here, "..", "..", "..", "sdks", "swift", "Package.swift"),
      "utf8",
    );
    const block = /^\s+platforms:\s*\[([^\]]*)\]/m.exec(pkg)?.[1] ?? "";
    const floors = Object.fromEntries(
      [...block.matchAll(/\.(macOS|iOS|tvOS|visionOS)\(\.v(\d+)\)/g)].map(
        (m) => [m[1], m[2]],
      ),
    );
    expect(Object.keys(floors).sort()).toEqual([
      "iOS",
      "macOS",
      "tvOS",
      "visionOS",
    ]);
    // The umbrella product the pages tell a target to depend on, and the two packages it pulls.
    expect(pkg).toMatch(
      /\.library\(name: "PolarisKey", targets: \["PolarisKey"\]\)/,
    );
    const deps = [
      ...pkg.matchAll(
        /\.package\(url: "https:\/\/github\.com\/[^/]+\/([^"]+)"/g,
      ),
    ]
      .map((m) => m[1])
      .sort();
    expect(deps).toEqual(["Sparkle"]);
    const sentence = `macOS ${floors.macOS}, iOS ${floors.iOS}, tvOS ${floors.tvOS} and visionOS ${floors.visionOS}`;
    // The install page names every floor; the first-product page, under its word budget, names
    // the one a macOS command-line package needs.
    expect(read("src/content/docs", "build/install.mdx")).toContain(
      `floors are ${sentence}`,
    );
    for (const page of ["build/install.mdx", "start/first-product.mdx"]) {
      const text = read("src/content/docs", page);
      expect(text, page).toContain(`platforms: [.macOS(.v${floors.macOS})]`);
      expect(text, page).toContain(
        `.product(name: "PolarisKey", package: "${FEEDS.swift.package}")`,
      );
      expect(text, page).toContain("`Sparkle`");
      expect(text, page).toContain(".swiftpm/configuration/registries.json");
    }
  });

  it("both pages give the four ways to run a project's own pkey", () => {
    for (const page of ["build/install.mdx", "start/first-product.mdx"]) {
      const text = read("src/content/docs", page);
      for (const form of [
        "npx pkey",
        "pnpm exec pkey",
        "yarn pkey",
        "bunx pkey",
      ])
        expect(text, `${page}: ${form}`).toContain(`\`${form}\``);
    }
  });

  it("the first-product page opens the console where the worker mounts it", () => {
    const router = readFileSync(
      join(here, "..", "..", "worker", "src", "router.ts"),
      "utf8",
    );
    expect(router).toMatch(
      /path === "\/manage" \|\| path\.startsWith\("\/manage\/"\)\)\s*return \{ kind: "adminSpa" \}/,
    );
    expect(read("src/content/docs", "start/first-product.mdx")).toContain(
      "https://key.plrs.im/manage/",
    );
  });
});
