/**
 * P2b-02 — the CLI side of `.pkey/distribution`: `pkey validate` reads and reports it, and
 * `pkey distribution outlet-ids --outlet <id>` turns it into the `outletIds` JSON CI hands a Godot
 * export as `PKEY_OUTLET_IDS` (P1-11; notes/S-06 rule 4).
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initManifest, runPkey } from "../src/index.js";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pkey-dist-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function capture() {
  let out = "";
  let err = "";
  return {
    stdout: { write: (c: string) => ((out += c), true) },
    stderr: { write: (c: string) => ((err += c), true) },
    out: () => out,
    err: () => err,
  };
}

/** A scaffolded product with Release, Distribution and Update on. */
async function product(): Promise<string> {
  const cwd = await tempDir();
  await initManifest({
    cwd,
    slug: "dice",
    name: "Dice",
    modules: ["releases"],
  });
  return cwd;
}

const DISTRIBUTION_YAML = `# yaml-language-server: $schema=../node_modules/@polaris-key/manifest/schemas/v1/distribution.schema.json
outlets:
  direct:
    platforms: [macos, windows, linux]
    homebrewCask: dice
  steam:
    appId: 480
    branches: { beta: beta }
  itch:
    target: vlad/dice
    gameId: 1001
  flathub:
    appId: gg.vlad.Dice
  snap:
    name: dice
  ms-store:
    productId: 9NBLGGH4NNS1
    packageFamilyName: Vlad.Dice_abcdefghjkmnp
  app-installer:
    packageFamilyName: Vlad.Dice_1a2b3c4d5e6f7
  web: {}
`;

/** The same document as JSON (numeric ids as numbers, exactly as the YAML parses). */
const DISTRIBUTION_JSON = JSON.stringify({
  outlets: {
    direct: { platforms: ["macos", "windows", "linux"], homebrewCask: "dice" },
    steam: { appId: 480, branches: { beta: "beta" } },
    itch: { target: "vlad/dice", gameId: 1001 },
    flathub: { appId: "gg.vlad.Dice" },
    snap: { name: "dice" },
    "ms-store": {
      productId: "9NBLGGH4NNS1",
      packageFamilyName: "Vlad.Dice_abcdefghjkmnp",
    },
    "app-installer": { packageFamilyName: "Vlad.Dice_1a2b3c4d5e6f7" },
    web: {},
  },
});

async function outletIds(cwd: string, ...args: string[]) {
  const io = capture();
  const code = await runPkey(["distribution", "outlet-ids", ...args], {
    cwd,
    ...io,
  });
  return { code, out: io.out(), err: io.err() };
}

describe("pkey distribution outlet-ids", () => {
  const EXPECTED =
    '{"caskToken":"dice","flatpakId":"gg.vlad.Dice","itchGameId":"1001","msixFamilyName":"Vlad.Dice_abcdefghjkmnp","snapName":"dice","steamAppId":"480"}\n';

  it("prints the mapped object, every value a string, keys sorted, with the ms-store family name", async () => {
    const cwd = await product();
    await writeFile(
      path.join(cwd, ".pkey/distribution.yaml"),
      DISTRIBUTION_YAML,
    );
    const res = await outletIds(cwd, "--outlet", "ms-store");
    expect(res).toEqual({ code: 0, out: EXPECTED, err: "" });
    const parsed = JSON.parse(res.out) as Record<string, unknown>;
    expect(Object.values(parsed).every((v) => typeof v === "string")).toBe(
      true,
    );
    expect(parsed.itchGameId).toBe("1001");
    expect(parsed.steamAppId).toBe("480");
  });

  it("the equivalent .json file gives the same bytes", async () => {
    const cwd = await product();
    await writeFile(
      path.join(cwd, ".pkey/distribution.json"),
      DISTRIBUTION_JSON,
    );
    expect(await outletIds(cwd, "--outlet", "ms-store")).toEqual({
      code: 0,
      out: EXPECTED,
      err: "",
    });
  });

  it("takes msixFamilyName from the build's own entry only", async () => {
    const cwd = await product();
    await writeFile(
      path.join(cwd, ".pkey/distribution.yml"),
      DISTRIBUTION_YAML,
    );
    const installer = JSON.parse(
      (await outletIds(cwd, "--outlet", "app-installer")).out,
    ) as Record<string, string>;
    expect(installer.msixFamilyName).toBe("Vlad.Dice_1a2b3c4d5e6f7");
    const steam = JSON.parse(
      (await outletIds(cwd, "--outlet=steam")).out,
    ) as Record<string, string>;
    expect(steam.msixFamilyName).toBeUndefined();
    expect(steam.steamAppId).toBe("480");
  });

  it("prints {} and exits 0 with no .pkey/distribution, for any --outlet", async () => {
    const cwd = await product();
    for (const outlet of ["ms-store", "steam", "not-declared-anywhere"])
      expect(await outletIds(cwd, "--outlet", outlet)).toEqual({
        code: 0,
        out: "{}\n",
        err: "",
      });
    // The absent-file check comes before anything else: no manifest at all is still {}.
    const empty = await tempDir();
    expect(await outletIds(empty, "--outlet", "steam")).toEqual({
      code: 0,
      out: "{}\n",
      err: "",
    });
  });

  it("exits non-zero for an outlet the file does not declare", async () => {
    const cwd = await product();
    await writeFile(
      path.join(cwd, ".pkey/distribution.yaml"),
      DISTRIBUTION_YAML,
    );
    const res = await outletIds(cwd, "--outlet", "play");
    expect(res.code).not.toBe(0);
    expect(res.out).toBe("");
    expect(res.err).toContain('outlet "play" is not declared');
  });

  it("exits non-zero when the manifest does not validate", async () => {
    const cwd = await product();
    await writeFile(
      path.join(cwd, ".pkey/distribution.yaml"),
      "outlets:\n  steam:\n    appId: 480\n    capabilities: { codeUpdates: true }\n",
    );
    const res = await outletIds(cwd, "--outlet", "steam");
    expect(res.code).toBe(1);
    expect(res.out).toBe("");
    expect(res.err).toContain("distribution/outlets/steam/capabilities");
  });

  it("requires --outlet and the outlet-ids subcommand", async () => {
    const cwd = await product();
    expect((await outletIds(cwd)).code).toBe(1);
    const io = capture();
    expect(await runPkey(["distribution"], { cwd, ...io })).toBe(1);
    expect(io.err()).toContain("Usage: pkey distribution outlet-ids --outlet");
  });
});

describe("pkey validate and .pkey/distribution", () => {
  it("reports a distribution error with the document, pointer and file name", async () => {
    const cwd = await product();
    await writeFile(
      path.join(cwd, ".pkey/distribution.yaml"),
      "outlets:\n  itch:\n    gameId: acme/dice\n",
    );
    const io = capture();
    expect(await runPkey(["validate"], { cwd, ...io })).toBe(1);
    expect(io.out()).toContain(
      "error distribution/outlets/itch/gameId (.pkey/distribution.yaml): outlets.itch.gameId must be",
    );
  });

  it("accepts a valid document", async () => {
    const cwd = await product();
    await writeFile(
      path.join(cwd, ".pkey/distribution.yaml"),
      DISTRIBUTION_YAML,
    );
    const io = capture();
    expect(await runPkey(["validate"], { cwd, ...io })).toBe(0);
    expect(io.out()).toContain("Manifest: valid");
  });
});
