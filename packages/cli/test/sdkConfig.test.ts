// `pkey sdk --lang <lang> --write` and `pkey mirror` (SDK parity pass §3.19, SP-02).
//
// The rendered modules are committed as samples inside each SDK's own test tree, and each SDK
// compiles (and, where it can, runs) its sample against its real API. This file pins the samples
// to today's renderer, so a renderer change that an SDK would not accept fails here first.
// Regenerate them with `PKEY_UPDATE_SAMPLES=1 pnpm --filter @polaris-key/cli test sdkConfig`.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { initManifest, runPkey } from "../src/index.js";
import {
  renderSdkConfig,
  resolveSdkFacts,
  SDK_LANGS,
  type SdkConfigFacts,
  type SdkLang,
} from "../src/sdkConfig.js";
import { renderCliMirror, renderMirror } from "../src/mirrors.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "../../..");
const DISCOVERY = JSON.parse(
  await readFile(path.join(HERE, "fixtures/sdk-config/discovery.json"), "utf8"),
) as Record<string, unknown>;
const TRUST_KID = "pkey-test-prod-2026";
const TRUST_KEY = "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI";
const RELEASE_KID = "acme-release-2026";
const RELEASE_KEY = "Z6FCkd1K7Om4lxUk4og_J0m73saH4BrrLk8igXzwcJM";
const OTHER_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

/** Where each SDK keeps (and compiles) its sample. */
const SAMPLES: Record<SdkLang, { file: string; kotlinPackage?: string }> = {
  node: { file: "conformance/runners/node/sdkConfigSample.ts" },
  react: { file: "packages/sdk-react/test/sdkConfigSample.ts" },
  python: { file: "sdks/python/tests/sdk_config_sample.py" },
  swift: { file: "sdks/swift/Tests/PolarisKeyTests/SdkConfigSample.swift" },
  kotlin: {
    file: "sdks/kotlin/sdk/src/test/kotlin/polaris/generated/PolarisConfig.kt",
    kotlinPackage: "polaris.generated",
  },
  godot: { file: "sdks/godot/tests/sdk_config/polaris_key_config.gd" },
};

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
async function tempDir(): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), "pkey-sdk-"));
  dirs.push(d);
  return d;
}

function fakeFetch(
  doc: unknown,
  status = 200,
): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return new Response(JSON.stringify(doc), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, urls };
}

function capture() {
  let out = "";
  let err = "";
  return {
    stdout: {
      write: (c: string) => {
        out += c;
        return true;
      },
    },
    stderr: {
      write: (c: string) => {
        err += c;
        return true;
      },
    },
    out: () => out,
    err: () => err,
  };
}

async function facts(
  doc: unknown = DISCOVERY,
  releaseKeys = [{ kid: RELEASE_KID, publicKey: RELEASE_KEY }],
  extra: Partial<Parameters<typeof resolveSdkFacts>[0]> = {},
): Promise<SdkConfigFacts> {
  return resolveSdkFacts({
    product: "acme",
    baseUrl: "https://key.plrs.im/",
    releaseKeys,
    fetchImpl: fakeFetch(doc).fetchImpl,
    ...extra,
  });
}

describe("pkey sdk --lang", () => {
  it("resolves the product facts from discovery and .pkey/release", async () => {
    const { fetchImpl, urls } = fakeFetch(DISCOVERY);
    const f = await resolveSdkFacts({
      product: "acme",
      baseUrl: "https://key.plrs.im/",
      releaseKeys: [{ kid: RELEASE_KID, publicKey: RELEASE_KEY }],
      fetchImpl,
    });
    expect(urls).toEqual(["https://key.plrs.im/acme/.well-known/polaris.json"]);
    expect(f).toEqual({
      product: "acme",
      baseUrl: "https://key.plrs.im",
      discoveryUrl: "https://key.plrs.im/acme/.well-known/polaris.json",
      pinnedKeys: { [TRUST_KID]: TRUST_KEY },
      pinnedReleaseKeys: { [RELEASE_KID]: RELEASE_KEY },
      services: ["license", "config", "release", "update"],
    });
  });

  it.each(SDK_LANGS)(
    "the committed %s sample is today's renderer",
    async (lang) => {
      const sample = SAMPLES[lang];
      const rendered = renderSdkConfig(lang, await facts(), {
        out: sample.file,
        ...(sample.kotlinPackage
          ? { kotlinPackage: sample.kotlinPackage }
          : {}),
      });
      const target = path.join(ROOT, sample.file);
      if (process.env.PKEY_UPDATE_SAMPLES === "1") {
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, rendered, "utf8");
      }
      expect(await readFile(target, "utf8")).toBe(rendered);
    },
  );

  it("refuses a release key discovery does not advertise", async () => {
    await expect(
      facts(DISCOVERY, [
        { kid: RELEASE_KID, publicKey: RELEASE_KEY },
        { kid: "stale-key", publicKey: OTHER_KEY },
      ]),
    ).rejects.toThrow(/does not advertise release key stale-key/);
  });

  it("refuses when discovery advertises a release key that was not declared", async () => {
    await expect(facts(DISCOVERY, [])).rejects.toThrow(
      /advertises 1 release key you did not declare/,
    );
  });

  it("refuses a release key that is also a trust pin", async () => {
    const doc = structuredClone(DISCOVERY) as {
      services: { release: { releaseKeyFingerprints: string[] } };
    };
    doc.services.release.releaseKeyFingerprints = [];
    await expect(
      facts(doc, [{ kid: "dup", publicKey: TRUST_KEY }]),
    ).rejects.toThrow(/also a trust pin/);
  });

  it("refuses an expected pin discovery does not serve", async () => {
    await expect(
      facts(DISCOVERY, undefined, {
        expectPin: { kid: TRUST_KID, publicKey: OTHER_KEY },
      }),
    ).rejects.toThrow(/does not pin pkey-test-prod-2026/);
    await expect(
      facts(DISCOVERY, undefined, {
        expectPin: { kid: TRUST_KID, publicKey: TRUST_KEY },
      }),
    ).resolves.toBeTruthy();
  });

  it("refuses a product or protocol mismatch, a non-https origin and a malformed pin", async () => {
    await expect(facts({ ...DISCOVERY, product: "other" })).rejects.toThrow(
      /names product "other"/,
    );
    await expect(facts({ ...DISCOVERY, protocolVersion: 3 })).rejects.toThrow(
      /speaks protocol 3/,
    );
    await expect(
      facts(DISCOVERY, undefined, { baseUrl: "http://key.plrs.im" }),
    ).rejects.toThrow(/must be https/);
    await expect(
      facts({
        ...DISCOVERY,
        trust: { pinnedKeys: { [TRUST_KID]: 'x"; drop' } },
      }),
    ).rejects.toThrow(/malformed entry/);
  });

  it("writes the module, refuses to replace a hand-written file and reads .pkey/release", async () => {
    const cwd = await tempDir();
    await initManifest({
      cwd,
      slug: "acme",
      name: "Acme",
      modules: ["license", "config", "release"],
      releaseOwner: "acme",
      releaseRepo: "acme",
    });
    const releaseFile = path.join(cwd, ".pkey/release.yaml");
    const release = await readFile(releaseFile, "utf8");
    expect(release).toMatch(/\nrelease:\n/);
    await writeFile(
      releaseFile,
      release.replace(
        /\nrelease:\n/,
        `\nrelease:\n  releaseKeys:\n    - kid: ${RELEASE_KID}\n      publicKey: ${RELEASE_KEY}\n`,
      ),
    );
    const { fetchImpl } = fakeFetch(DISCOVERY);
    const io = capture();
    expect(
      await runPkey(["sdk", "--lang", "python", "--write"], {
        cwd,
        fetchImpl,
        ...io,
      }),
      io.err(),
    ).toBe(0);
    const written = await readFile(path.join(cwd, "polaris_config.py"), "utf8");
    expect(written).toBe(renderSdkConfig("python", await facts()));
    expect(io.out()).toContain(`${TRUST_KID}  sha256:`);
    expect(io.out()).toContain(RELEASE_KID);

    // A second run replaces its own output; a hand-written file needs --force.
    expect(
      await runPkey(["sdk", "--lang", "python", "--write"], {
        cwd,
        fetchImpl,
        ...capture(),
      }),
    ).toBe(0);
    await writeFile(path.join(cwd, "mine.py"), "PINS = {}\n");
    const err = { write: () => true };
    expect(
      await runPkey(
        ["sdk", "--lang", "python", "--write", "--out", "mine.py"],
        { cwd, fetchImpl, stdout: capture().stdout, stderr: err },
      ),
    ).toBe(1);
    expect(await readFile(path.join(cwd, "mine.py"), "utf8")).toBe(
      "PINS = {}\n",
    );
  });

  it("prints to stdout without --write, and takes --release-key outside a product repo", async () => {
    const cwd = await tempDir();
    const io = capture();
    expect(
      await runPkey(
        [
          "sdk",
          "--lang",
          "node",
          "--product",
          "acme",
          "--release-key",
          `${RELEASE_KID}=${RELEASE_KEY}`,
        ],
        { cwd, fetchImpl: fakeFetch(DISCOVERY).fetchImpl, ...io },
      ),
    ).toBe(0);
    expect(io.out()).toBe(renderSdkConfig("node", await facts()));
  });

  it("emits a JavaScript module for a .js --out", async () => {
    const js = renderSdkConfig("node", await facts(), {
      out: "polaris.config.mjs",
    });
    expect(js).not.toContain("import type");
    expect(js).toContain("@satisfies");
  });
});

describe("pkey mirror", () => {
  const catalog = {
    schemaVersion: 3,
    entries: [
      {
        key: "audio.volume",
        kind: "config",
        category: "Audio",
        label: "Volume",
        description: "Master volume",
        schema: { type: "number", minimum: 0, maximum: 1 },
        default: 0.8,
      },
    ],
  };

  it("renders what the monorepo generator renders, under its own banner", () => {
    for (const lang of [
      "ts",
      "python",
      "swift",
      "gdscript",
      "kotlin",
    ] as const) {
      const tools = renderMirror(lang, catalog as never);
      const cli = renderCliMirror(lang, catalog as never);
      expect(tools.split("\n")[0]).toContain("tools/gen-mirrors.ts");
      expect(cli.split("\n")[0]).toContain("`pkey mirror`");
      expect(cli.split("\n").slice(1)).toEqual(tools.split("\n").slice(1));
    }
  });

  it("writes mirrors from the schema route and checks them", async () => {
    const cwd = await tempDir();
    const { fetchImpl, urls } = fakeFetch(catalog);
    const io = capture();
    expect(
      await runPkey(
        [
          "mirror",
          "--lang",
          "ts,python",
          "--product",
          "acme",
          "--out-dir",
          "gen",
        ],
        { cwd, fetchImpl, ...io },
      ),
    ).toBe(0);
    expect(urls).toEqual(["https://key.plrs.im/acme/config/schema"]);
    expect(
      await readFile(path.join(cwd, "gen/catalog.generated.ts"), "utf8"),
    ).toBe(renderCliMirror("ts", catalog as never));
    expect(
      await runPkey(
        [
          "mirror",
          "--lang",
          "ts,python",
          "--product",
          "acme",
          "--out-dir",
          "gen",
          "--check",
        ],
        { cwd, fetchImpl, ...capture() },
      ),
    ).toBe(0);
    await writeFile(path.join(cwd, "gen/catalog_generated.py"), "stale\n");
    expect(
      await runPkey(
        [
          "mirror",
          "--lang",
          "python",
          "--product",
          "acme",
          "--out-dir",
          "gen",
          "--check",
        ],
        { cwd, fetchImpl, ...capture() },
      ),
    ).toBe(1);
  });

  it("reads a catalog file and refuses an unknown language", async () => {
    const cwd = await tempDir();
    await writeFile(path.join(cwd, "catalog.json"), JSON.stringify(catalog));
    expect(
      await runPkey(
        ["mirror", "--lang", "kotlin", "--catalog", "catalog.json"],
        {
          cwd,
          ...capture(),
        },
      ),
    ).toBe(0);
    expect(
      await readFile(path.join(cwd, "ConfigSchema.generated.kt"), "utf8"),
    ).toContain("`pkey mirror`");
    expect(
      await runPkey(["mirror", "--lang", "rust", "--catalog", "catalog.json"], {
        cwd,
        stdout: capture().stdout,
        stderr: { write: () => true },
      }),
    ).toBe(1);
  });
});
