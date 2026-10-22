// The integration content generator (SP-33a, SDX-02): renderSdkSetup, renderUsage, sdkFit and the
// rule that there is only one of them. The goldens' bytes are held by `pnpm gen integration --check`;
// they compile in the docs lanes (packages/docs/test/integrationGoldens.test.ts).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  INTEGRATION_FEATURES,
  SDK_IDS,
  allUsageBlocks,
  renderSdkSetup,
  renderUsage,
  sdkFit,
  usageFrameworks,
} from "../src/integration/index.js";

const ROOT = join(fileURLToPath(import.meta.url), "../../../..");
const PINS = [
  { kid: "tb-a", publicKey: "A".repeat(43) },
  { kid: "tb-b", publicKey: "B".repeat(43) },
];

describe("renderSdkSetup", () => {
  it("renders install, config and a start for every SDK", () => {
    for (const sdk of SDK_IDS) {
      const s = renderSdkSetup(sdk, {
        slug: "tonebox",
        pins: PINS,
        services: ["license"],
      });
      expect(s.install.length, sdk).toBeGreaterThan(0);
      expect(s.install[0]?.code, sdk).toContain("https://pkg.plrs.im/");
      expect(s.config.code, sdk).toContain("A".repeat(43));
      expect(s.config.code, sdk).toContain("B".repeat(43));
      expect(s.start.feature).toBe("licensing");
      expect(s.start.docs).toMatch(/^\/docs\/.+\/$/);
    }
  });

  it("carries the trust pins in React's provider config (P0-47)", () => {
    const s = renderSdkSetup("react", {
      slug: "tonebox",
      pins: PINS,
      services: ["license"],
    });
    expect(s.config.code).toContain("trust: { pinnedKeys },");
    expect(s.config.code).toContain(`"tb-a": "${"A".repeat(43)}"`);
  });

  it("starts a Node CLI on the terminal kit, Electron on the bridge and a server on the library", () => {
    const base = {
      slug: "tonebox",
      pins: PINS,
      services: ["license" as const],
    };
    expect(
      renderSdkSetup("node", {
        ...base,
        fit: { host: "cli", framework: "commander" },
      }).start.code,
    ).toContain("registerPolarisCommands");
    expect(
      renderSdkSetup("node", {
        ...base,
        fit: { host: "app", target: "electron" },
      }).start.code,
    ).toContain("exposePolarisBridge");
    const server = renderSdkSetup("node", { ...base, fit: { host: "server" } });
    expect(server.start.lane).toBe("server");
    expect(server.start.code).toContain("verifyLicenseDocument");
    // B-049: the install line names the package the start block imports.
    const installs = (x: typeof server) =>
      x.install.map((i) => i.code).join("\n");
    expect(server.start.code).toContain('"@polaris-key/server"');
    expect(installs(server)).toContain("@polaris-key/server");
    expect(installs(server)).not.toContain("@polaris-key/node");
    expect(installs(renderSdkSetup("node", base))).toContain(
      "@polaris-key/node",
    );
    // B-050: US spelling in titles, file names and comments.
    for (const sdk of ["node", "react", "python", "swift", "kotlin"] as const)
      for (const b of [
        renderSdkSetup(sdk, base).start,
        renderSdkSetup(sdk, base).headless,
      ])
        if (b)
          expect(`${b.title} ${b.filename} ${b.code}`).not.toMatch(/licence/i);
    expect(server.start.code).not.toMatch(/licence/i);
    // The drop-in is the start; the library block sits beside it.
    expect(renderSdkSetup("react", base).headless?.lane).toBe("library");
  });

  it("warns on Update without release keys and on a product with no key", () => {
    const base = {
      slug: "tonebox",
      pins: PINS,
      services: ["license" as const, "update" as const],
    };
    expect(renderSdkSetup("node", base).warnings).toHaveLength(1);
    expect(
      renderSdkSetup("node", {
        ...base,
        releaseKeys: [{ kid: "r", publicKey: "R".repeat(43) }],
      }).warnings,
    ).toEqual([]);
    expect(
      renderSdkSetup("node", { ...base, pins: [], services: [] }).warnings[0],
    ).toMatch(/no signing key/);
  });

  it("routes the feed before it installs (strict index) and adds an Xcode tab", () => {
    const py = renderSdkSetup("python", {
      slug: "t",
      pins: PINS,
      services: [],
    });
    expect(py.install[0]?.code).toContain("explicit = true");
    expect(py.install.map((s) => s.code).join("\n")).not.toContain(
      "--extra-index-url",
    );
    const swift = renderSdkSetup("swift", {
      slug: "t",
      pins: PINS,
      services: [],
    });
    expect(swift.install.map((s) => s.id)).toEqual([
      "registries-json",
      "package-swift",
      "xcode",
    ]);
  });
});

describe("renderUsage", () => {
  it("renders the product's real names into every compiled block", () => {
    const b = renderUsage("config", "node", "library", null, {
      configKey: "run.concurrency",
      configFallback: 3,
      secretKey: "s.key",
      mintRecipe: "r1",
    });
    expect(b?.code).toContain('getConfig("run.concurrency", 3)');
    expect(b?.code).toContain('getSecret("s.key")');
    expect(b?.code).toContain('mintToken("r1")');
    expect(b?.compiled).toBe(true);
    expect(
      renderUsage("config", "python", "library", null, { configFallback: true })
        ?.code,
    ).toContain('get_config("audio.musicVolume", True)');
  });

  it("renders null where an SDK has no such code, never a guess", () => {
    expect(renderUsage("packs", "react", "library")).toBeNull();
    expect(renderUsage("licensing", "python", "server")).toBeNull();
    expect(renderUsage("licensing", "swift", "server")).toBeNull();
    expect(
      renderUsage("licensing", "node", "kit", "no-such-framework"),
    ).toBeNull();
    // A server framework with no drop-in yet.
    expect(renderUsage("licensing", "node", "server", "fastify")).toBeNull();
    expect(renderUsage("licensing", "kotlin", "server", "spring")).toBeNull();
  });

  it("renders each shipped server drop-in under its framework, with its docs page", () => {
    expect(usageFrameworks("node", "server")).toEqual([
      "express",
      "hono",
      "next",
    ]);
    expect(usageFrameworks("python", "server")).toEqual([
      "fastapi",
      "starlette",
      "flask",
      "django",
      "drf",
    ]);
    expect(usageFrameworks("kotlin", "server")).toEqual(["ktor"]);
    for (const [sdk, fw] of [
      ["node", "express"],
      ["node", "hono"],
      ["node", "next"],
      ["python", "fastapi"],
      ["python", "starlette"],
      ["python", "flask"],
      ["python", "django"],
      ["python", "drf"],
      ["kotlin", "ktor"],
    ] as const) {
      const b = renderUsage("licensing", sdk, "server", fw, {
        entitlement: "vpn",
      });
      expect(b?.code).toContain('"vpn"');
      expect(b?.docs).toBe(`/docs/build/servers/${fw}/`);
    }
    // Sign-in on the drop-ins that expose the account.
    expect(
      renderUsage("identity", "node", "server", "express")?.code,
    ).toContain("user?.subject");
    expect(
      renderUsage("identity", "python", "server", "fastapi")?.code,
    ).toContain("auth.user");
    // The CLI frameworks mount the verbs and gate a command.
    for (const [sdk, fw] of [
      ["node", "commander"],
      ["node", "yargs"],
      ["python", "argparse"],
      ["python", "click"],
      ["python", "typer"],
    ] as const)
      expect(renderUsage("licensing", sdk, "kit", fw)?.code).toMatch(
        /requireLicense|require_license/,
      );
  });

  it("marks Cloud Sync planned, and every block ends in one newline with a docs link", () => {
    expect(renderUsage("sync", "node", "library")?.status).toBe("planned");
    const all = allUsageBlocks();
    expect(all.length).toBeGreaterThan(25);
    const ids = new Set(all.map((b) => b.id));
    expect(ids.size).toBe(all.length);
    for (const b of all) {
      expect(b.code, b.id).toMatch(/[^\n]\n$/);
      expect(b.docs, b.id).toMatch(/^\/docs\/.+\/$/);
    }
    expect(INTEGRATION_FEATURES).toHaveLength(7);
  });

  it("imports the generated config, so no pin or slug appears in a usage block", () => {
    for (const b of allUsageBlocks()) {
      if (b.feature === "licensing" && b.lane === "kit" && b.sdk === "godot")
        continue;
      expect(b.code, b.id).not.toMatch(/PUB-|pinnedKeys: \{\s*"/);
    }
  });
});

describe("sdkFit frameworks", () => {
  it.each([
    [{ npm: ["express"] }, "node", "server", "express"],
    [{ npm: ["hono"] }, "node", "server", "hono"],
    [{ npm: ["next", "react"] }, "node", "server", "next"],
    [{ python: ["fastapi"] }, "python", "server", "fastapi"],
    [{ python: ["starlette"] }, "python", "server", "starlette"],
    [{ python: ["Flask>=3"] }, "python", "server", "flask"],
    [{ python: ["Django"] }, "python", "server", "django"],
    [{ python: ["djangorestframework"] }, "python", "server", "drf"],
    [{ gradle: ["io.ktor:ktor-server-core:3"] }, "kotlin", "server", "ktor"],
    [{ npm: ["commander"] }, "node", "cli", "commander"],
    [{ npm: ["yargs"] }, "node", "cli", "yargs"],
    [{ python: ["click"] }, "python", "cli", "click"],
    [{ python: ["typer"] }, "python", "cli", "typer"],
  ] as const)("detects %j", (repo, sdk, host, framework) => {
    expect(sdkFit([], repo)).toMatchObject({ sdk, host, framework });
  });
});

describe("sdkFit", () => {
  it("picks a host and framework from the repo, over the platforms", () => {
    expect(sdkFit(["windows"], { npm: ["express", "react"] })).toEqual({
      sdk: "node",
      host: "server",
      target: "server",
      framework: "express",
    });
    expect(sdkFit([], { python: ["FastAPI[all]>=0.100"] })).toMatchObject({
      sdk: "python",
      host: "server",
      framework: "fastapi",
    });
    expect(
      sdkFit([], { gradle: ["io.ktor:ktor-server-core:2.3"] }),
    ).toMatchObject({
      sdk: "kotlin",
      host: "server",
      framework: "ktor",
    });
    expect(sdkFit([], { swift: ["vapor"] })).toMatchObject({
      sdk: "swift",
      host: "server",
      framework: "vapor",
    });
    expect(sdkFit([], { npm: ["commander"] })).toMatchObject({
      sdk: "node",
      host: "cli",
      framework: "commander",
    });
    expect(sdkFit([], { python: ["typer"] })).toMatchObject({
      sdk: "python",
      host: "cli",
      framework: "typer",
    });
    expect(sdkFit([], { npm: ["electron", "react"] })).toMatchObject({
      sdk: "node",
      target: "electron",
    });
    expect(sdkFit([], { python: ["PySide6"] })).toMatchObject({
      sdk: "python",
      target: "qt",
    });
    expect(sdkFit([], { godot: true }).sdk).toBe("godot");
  });

  it("falls back to the platforms, and answers null for none", () => {
    expect(sdkFit(["android"]).sdk).toBe("kotlin");
    expect(sdkFit(["ios"]).sdk).toBe("swift");
    expect(sdkFit(["web"]).sdk).toBe("react");
    expect(sdkFit(["server"]).host).toBe("server");
    expect(sdkFit([])).toEqual({
      sdk: null,
      host: null,
      target: null,
      framework: null,
    });
  });
});

describe("one snippet generator", () => {
  const FORBIDDEN =
    /function (sdkInit|sdkSnippet|trustSnippet|renderNode|renderReact|renderPython|renderSwift|renderKotlin|renderGodot)\(/;
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(name)) out.push(p);
    }
    return out;
  };

  it("keeps SDK setup renderers out of the console and the CLI", () => {
    const hits: string[] = [];
    for (const dir of ["packages/admin/src", "packages/cli/src"])
      for (const f of walk(join(ROOT, dir)))
        if (FORBIDDEN.test(readFileSync(f, "utf8"))) hits.push(f);
    // `renderPython` etc. in the CLI's mirrors.ts are the catalog mirrors, a different artefact.
    expect(hits.filter((f) => !f.endsWith("cli/src/mirrors.ts"))).toEqual([]);
  });
});
