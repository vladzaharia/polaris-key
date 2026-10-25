/**
 * P4-33.4 — `pkey channel sync --deliverable <pack> --from <dir>` runs the transport rows:
 * Background Assets package then upload, the Steam vdf then the allow-listed steamcmd build.
 * The steps themselves are covered by transport.test.ts; here they are spies, the vendor tool a
 * fake spawn and Polaris Key a fake fetch.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { packRepo, testReleaseKey } from "./packFixtures.js";

const calls: { step: string; opts: Record<string, unknown> }[] = [];
const failing = new Set<string>();

vi.mock("../src/transportAppleBa.js", async (orig) => ({
  ...(await orig<object>()),
  baPackage: vi.fn(async (o: Record<string, unknown>) => {
    calls.push({ step: "apple-ba package", opts: o });
    if (failing.has("apple-ba package")) throw new Error("xcrun failed\nmore");
  }),
  baUpload: vi.fn(async (o: Record<string, unknown>) => {
    calls.push({ step: "apple-ba upload", opts: o });
    if (failing.has("apple-ba upload")) throw new Error("ASC said no");
  }),
}));
vi.mock("../src/transportSteam.js", async (orig) => ({
  ...(await orig<object>()),
  steamVdf: vi.fn(async (o: { cwd: string; depot: string }) => {
    calls.push({ step: "steam-depot vdf", opts: o });
    if (failing.has("steam-depot vdf")) throw new Error("no such depot");
    const out = path.join(o.cwd, "build/pkey-transport/steam");
    await mkdir(out, { recursive: true });
    const appBuild = path.join(out, "app_build_480.vdf");
    await writeFile(appBuild, '"AppBuild"\n{\n\t"SetLive" ""\n}\n');
    return { appBuild };
  }),
}));

const { cmdChannel } = await import("../src/channel.js");

const BASE = "https://key.test";
const PACK = "diceroll.core3d";
const ENV = {
  PKEY_CI_TOKEN: `pkeyci_${"A".repeat(43)}`,
  ASC_KEY_ID: "k",
  ASC_ISSUER_ID: "i",
  ASC_PRIVATE_KEY: "pem-secret-value",
  STEAM_USERNAME: "builder",
  STEAM_CONFIG_VDF: "vdf-secret-value",
  VERSION_TAG: "",
};

async function repo(): Promise<string> {
  const cwd = await packRepo(testReleaseKey(), {});
  await writeFile(
    path.join(cwd, ".pkey/distribution.yaml"),
    `outlets:
  app-store:
    appleId: "1234567890"
    bundleId: gg.vlad.diceroll
  steam:
    appId: 480
    depots: { ${PACK}: "481" }
transports:
  packs: auto
`,
  );
  return cwd;
}

async function run(
  args: string[],
  o: {
    env?: Record<string, string | undefined>;
    spawn?: (tool: string, argv: readonly string[]) => Promise<number>;
  } = {},
) {
  const cwd = await repo();
  const bin = path.join(cwd, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "steamcmd"), "#!/bin/sh\n", { mode: 0o755 });
  const spawned: { tool: string; argv: readonly string[] }[] = [];
  const reports: Record<string, unknown>[] = [];
  let out = "";
  let err = "";
  const code = await cmdChannel(
    {
      positional: ["sync"],
      flags: Object.fromEntries(
        [["base-url", BASE], ...args.map((a) => a.split("="))].map(([k, v]) => [
          k!.replace(/^--/, ""),
          v ?? true,
        ]),
      ),
      multi: {},
    },
    {
      cwd,
      env: { ...ENV, PATH: bin, ...o.env },
      stdout: { write: (s: string) => ((out += s), true) } as never,
      stderr: { write: (s: string) => ((err += s), true) } as never,
      platform: "darwin",
      sleep: async () => {},
      spawnTool: async (tool, argv) => {
        spawned.push({ tool, argv });
        return o.spawn ? o.spawn(tool, argv) : 0;
      },
      fetchImpl: (async (_u: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        reports.push(body);
        return new Response(
          JSON.stringify({
            ok: true,
            step: { opId: "op", state: body.state, replayed: false },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    },
  );
  return { code, out, err, spawned, reports, cwd };
}

const ARGS = [`--deliverable=${PACK}`, "--from=cache", "--version=1.0.0"];

beforeEach(() => {
  calls.length = 0;
  failing.clear();
});

describe("channel sync --deliverable runs the transport rows (P4-33.4)", () => {
  it("package then upload once per pack; vdf then the allow-listed steamcmd build", async () => {
    const r = await run([...ARGS, "--json"]);
    expect(r.code, r.err + r.out).toBe(0);
    expect(calls.map((c) => c.step)).toEqual([
      "apple-ba package",
      "apple-ba upload",
      "steam-depot vdf",
    ]);
    expect(calls[0]!.opts).toMatchObject({
      deliverable: PACK,
      version: "1.0.0",
      from: "cache",
      archive: true,
      platform: "darwin",
    });
    expect(calls[1]!.opts).toMatchObject({
      dir: "build/pkey-transport/apple-ba",
      from: "cache",
    });
    expect(calls[2]!.opts).toMatchObject({ depot: "481", channel: "stable" });
    expect(r.spawned).toEqual([
      {
        tool: "steamcmd",
        argv: [
          "+login",
          "builder",
          "+run_app_build",
          "build/pkey-transport/steam/app_build_480.vdf",
          "+quit",
        ],
      },
    ]);
    // The steam build is reported into the ledger like every store step.
    expect(
      r.reports.map((x) => [x["store"], x["command"], x["state"]]),
    ).toEqual([
      ["steam", "run-app-build", "pending"],
      ["steam", "run-app-build", "done"],
    ]);
    const steps = JSON.parse(r.out).steps;
    expect(steps.map((s: never) => [s["part"], s["state"]])).toEqual([
      ["package", "done"],
      ["upload", "done"],
      ["vdf", "done"],
      ["build", "done"],
    ]);
    expect(r.out + r.err).not.toContain("pem-secret-value");
    expect(r.out + r.err).not.toContain("vdf-secret-value");
  });

  it("one failure fails the run after the rest; the part after it is skipped", async () => {
    failing.add("apple-ba package");
    const r = await run(ARGS);
    expect(r.code).toBe(1);
    expect(calls.map((c) => c.step)).toEqual([
      "apple-ba package",
      "steam-depot vdf",
    ]);
    expect(r.spawned).toHaveLength(1);
    expect(r.out).toContain(
      "apple-ba package (app-store): failed: xcrun failed",
    );
    expect(r.out).toContain(
      "apple-ba upload (app-store): skipped: the step before it failed",
    );
    expect(r.out).toContain("steam-depot build (steam): built");
  });

  it("a failed vdf never reaches steamcmd; a steamcmd exit fails the row", async () => {
    failing.add("steam-depot vdf");
    const a = await run(ARGS);
    expect(a.code).toBe(1);
    expect(a.spawned).toEqual([]);
    failing.clear();
    const b = await run(ARGS, { spawn: async () => 3 });
    expect(b.code).toBe(1);
    expect(b.out).toContain(
      "steam-depot build (steam): failed: steamcmd exited 3",
    );
  });

  it("--dry-run runs nothing and prints the exact commands, the account by its variable", async () => {
    const r = await run([
      "--dry-run",
      `--deliverable=${PACK}`,
      "--from=cache",
      "--version=1.0.0",
    ]);
    expect(r.code, r.err + r.out).toBe(0);
    expect(calls).toEqual([]);
    expect(r.spawned).toEqual([]);
    expect(r.reports).toEqual([]);
    expect(r.out).toContain(
      `would run pkey transport apple-ba package --deliverable ${PACK} --release 1.0.0 --from cache`,
    );
    expect(r.out).toContain(
      `would run pkey transport apple-ba upload --deliverable ${PACK} --release 1.0.0 --dir build/pkey-transport/apple-ba --from cache`,
    );
    expect(r.out).toContain(
      `would run pkey transport steam-depot vdf --deliverable ${PACK} --release 1.0.0 --from cache --depot 481 --channel stable`,
    );
    expect(r.out).toContain(
      "would run steamcmd +login $STEAM_USERNAME +run_app_build build/pkey-transport/steam/app_build_480.vdf +quit",
    );
    expect(r.out).not.toContain("builder");
    expect(r.out).not.toContain("secret-value");
  });

  it("a dry run needs neither --version nor --from; a real run does", async () => {
    const dry = await run(["--dry-run", `--deliverable=${PACK}`]);
    expect(dry.code, dry.err).toBe(0);
    expect(dry.out).toContain("--release <version> --from <dir>");
    await expect(
      run([`--deliverable=${PACK}`, "--from=cache"]),
    ).rejects.toThrow(/--version is required/);
    await expect(
      run([`--deliverable=${PACK}`, "--version=1.0.0"]),
    ).rejects.toThrow(/--from is required/);
    expect(calls).toEqual([]);
  });

  it("skipped rows run nothing and say why", async () => {
    const r = await run(ARGS, {
      env: { ASC_KEY_ID: "", STEAM_USERNAME: "" },
    });
    expect(r.code).toBe(0);
    expect(calls).toEqual([]);
    expect(r.out).toContain("skipped: ASC_KEY_ID is not set");
    expect(r.out).toContain("skipped: STEAM_USERNAME is not set");
  });
});
