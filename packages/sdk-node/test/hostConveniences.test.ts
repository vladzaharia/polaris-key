// @pkey-feature outlet.detect license.entitlements crash.tags
// SDK parity pass SP-N15 (build stamp, Windows SignatureKind), SP-N16 (crashTags;
// verifyLicenseDocument moved to @polaris-key/server) and SP-N17 (version autoload).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAppVersion } from "../src/core/appVersion.js";
import { crashTagsFor } from "../src/server.js";
import {
  loadBuildStamp,
  readWindowsSignatureKind,
  WINDOWS_SIGNATURE_KIND_COMMAND,
} from "../src/update/stamp.js";
import { readOutletSignals } from "../src/update/outlet.js";
import { detectOutlet } from "@polaris-key/client-core";
import { seededClient, tempDir } from "./parityFixtures.js";

describe("build stamp autoload (SP-N15)", () => {
  it("finds .polaris_key/build.json beside the entry script, and PKEY_BUILD_STAMP first", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "app", ".polaris_key"), { recursive: true });
    writeFileSync(
      join(dir, "app", ".polaris_key", "build.json"),
      JSON.stringify({ pkeyBuild: 1, outlet: "itch", build: 42 }),
    );
    const found = loadBuildStamp({
      env: {},
      resourcesPath: null,
      execPath: "/nonexistent/node",
      scriptPath: join(dir, "app", "dist", "main.js"),
    });
    expect(found).toMatchObject({ outlet: "itch", build: 42 });
    const other = join(dir, "explicit.json");
    writeFileSync(other, JSON.stringify({ pkeyBuild: 1, outlet: "steam" }));
    expect(
      loadBuildStamp({
        env: { PKEY_BUILD_STAMP: other },
        resourcesPath: null,
        scriptPath: null,
      }),
    ).toMatchObject({ outlet: "steam" });
    expect(
      loadBuildStamp({
        env: {},
        resourcesPath: null,
        execPath: "/x/y",
        scriptPath: null,
      }),
    ).toBeNull();
  });

  it("the update client resolves its outlet from an autoloaded stamp", async () => {
    const dir = tempDir();
    const stamp = join(dir, "build.json");
    writeFileSync(
      stamp,
      JSON.stringify({
        pkeyBuild: 1,
        outlet: "direct",
        build: 7,
        format: "zip",
      }),
    );
    const { client } = await seededClient({
      extra: {
        update: {
          outletEnvironment: {
            env: { PKEY_BUILD_STAMP: stamp },
            platform: "linux",
            execPath: "/opt/app/app",
            scriptPath: null,
            isSea: true,
            electron: null,
          },
        },
      },
    });
    expect(client.update.outlet).toMatchObject({
      id: "direct",
      kind: "direct",
    });
  });
});

describe("Windows SignatureKind (SP-N15)", () => {
  it("runs one PowerShell line and accepts only WinRT's values", async () => {
    const seen: string[][] = [];
    const run = async (_p: string, args: readonly string[]) => (
      seen.push([...args]),
      "Store\r\n"
    );
    expect(await readWindowsSignatureKind({ platform: "win32", run })).toBe(
      "Store",
    );
    expect(seen[0]).toEqual([...WINDOWS_SIGNATURE_KIND_COMMAND]);
    expect(
      await readWindowsSignatureKind({
        platform: "win32",
        run: async () => "",
      }),
    ).toBeNull();
    expect(
      await readWindowsSignatureKind({ platform: "linux", run }),
    ).toBeNull();
  });

  it("feeds detection's attested windows.signatureKind signal", () => {
    const signals = readOutletSignals({
      platform: "win32",
      env: {},
      execPath: "C:/app/app.exe",
      scriptPath: null,
      isSea: true,
      electron: null,
      windowsSignatureKind: "Developer",
    });
    expect(signals["windows.signatureKind"]).toBe("Developer");
    const d = detectOutlet({ stamp: { kind: "ms-store" } as never, signals });
    expect(d.kind).not.toBe("ms-store");
  });
});

describe("crashTags (SP-N16)", () => {
  it("crashTags follows the Sentry convention", async () => {
    const { client } = await seededClient();
    expect(client.crashTags({ build: "77" })).toEqual({
      release: "app@1.2.3+77",
      environment: "stable",
      "pkey.outlet": "unknown",
    });
  });

  it("crashTagsFor writes the release the Worker's Sentry hook parses back", () => {
    // The vectors of packages/worker/test/surfaces/console/sentry.test.ts (parseSentryRelease): a release is
    // `<deliverable>@<version>[+<build>]`, the channel is `environment`, the outlet `pkey.outlet`.
    expect(
      crashTagsFor({
        version: "1.4.0",
        build: "12",
        channel: "stable",
        outlet: "itch",
      }),
    ).toEqual({
      release: "app@1.4.0+12",
      environment: "stable",
      "pkey.outlet": "itch",
    });
    expect(
      crashTagsFor({
        version: "2.0.0",
        deliverable: "levels.a",
        channel: "beta",
        outlet: "steam",
      }),
    ).toEqual({
      release: "levels.a@2.0.0",
      environment: "beta",
      "pkey.outlet": "steam",
    });
    // An empty build is no `+` (the hook reads `app@1.0.0+` as build null anyway).
    expect(
      crashTagsFor({ version: "1.0.0", build: "", channel: "stable" }).release,
    ).toBe("app@1.0.0");
  });
});

describe("version autoload (SP-N17)", () => {
  it("prefers Electron's app.getVersion(), then the nearest package.json, then warns", () => {
    expect(
      resolveAppVersion({
        electron: "35.0.0",
        loadElectron: () => ({ app: { getVersion: () => "4.5.6" } }),
      }),
    ).toBe("4.5.6");
    const files: Record<string, string> = {
      "/repo/package.json": JSON.stringify({ version: "2.0.1" }),
    };
    expect(
      resolveAppVersion({
        electron: undefined,
        entry: "/repo/dist/cli.js",
        cwd: "/nowhere",
        readText: (p) => files[p] ?? null,
      }),
    ).toBe("2.0.1");
    const warnings: string[] = [];
    expect(
      resolveAppVersion({
        electron: undefined,
        entry: undefined,
        cwd: "/nowhere",
        readText: () => null,
        warn: (m) => warnings.push(m),
      }),
    ).toBe("0.0.0");
    expect(warnings).toHaveLength(1);
  });
});
