import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  MODULE_SERVICES,
  SERVICE_SLUGS,
  parseManifest,
} from "@polaris-key/manifest";
import { afterEach, describe, expect, it } from "vitest";
import {
  initManifest,
  loadManifest,
  normalizeModules,
  runPkey,
  validateLoadedManifest,
} from "../src/index.js";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pkey-cli-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function capture(): {
  stdout: { write: (chunk: string) => boolean };
  stderr: { write: (chunk: string) => boolean };
  out: () => string;
  err: () => string;
} {
  let out = "";
  let err = "";
  return {
    stdout: {
      write: (chunk: string) => {
        out += chunk;
        return true;
      },
    },
    stderr: {
      write: (chunk: string) => {
        err += chunk;
        return true;
      },
    },
    out: () => out,
    err: () => err,
  };
}

describe("@polaris-key/cli", () => {
  it("initializes and validates a config/licensing manifest", async () => {
    const cwd = await tempDir();
    await initManifest({
      cwd,
      slug: "djdl",
      name: "DJDL",
      modules: ["licensing", "config"],
    });

    const productYaml = await readFile(
      path.join(cwd, ".pkey/product.yaml"),
      "utf8",
    );
    expect(productYaml).toContain("apiVersion: pkey.dev/v1");
    expect(
      await readFile(path.join(cwd, ".pkey/schema.yaml"), "utf8"),
    ).toContain("entries:");

    const manifest = await loadManifest(cwd);
    const result = validateLoadedManifest(manifest);
    expect(result.ok).toBe(true);
    // `modules: ["licensing", "config"]` is the legacy vocabulary; the scaffold writes the
    // canonical service slugs and the validator reports them (`licensing` -> `license`).
    expect(result.enabledModules).toEqual(["license", "config"]);
  });

  it("scaffolds a modules block of canonical service slugs, one per table row", async () => {
    const cwd = await tempDir();
    await initManifest({
      cwd,
      slug: "djdl",
      name: "DJDL",
      modules: ["licensing", "config", "releases"],
    });
    const product = await readFile(
      path.join(cwd, ".pkey/product.yaml"),
      "utf8",
    );
    const block = product.slice(
      product.indexOf("modules:\n"),
      product.indexOf("\n\n", product.indexOf("modules:\n")),
    );
    const keys = [...block.matchAll(/^ {2}([A-Za-z]+):$/gm)].map((m) => m[1]);
    expect(keys).toEqual([...SERVICE_SLUGS]);
    for (const legacy of ["licensing", "releases", "oidc", "edgeMint"])
      expect(block).not.toContain(`${legacy}:`);
    const result = validateLoadedManifest(await loadManifest(cwd));
    expect(result.ok).toBe(true);
    expect(result.enabledModules).toEqual([
      "license",
      "config",
      "release",
      "distribution",
      "update",
    ]);
  });

  it("scaffolds only canonical spellings: profileId, entries, no deprecated_spelling (ST-19)", async () => {
    for (const modules of [
      ["licensing", "config"],
      ["license", "config", "release", "identity"],
      ["releases"],
    ] as const) {
      const cwd = await tempDir();
      await initManifest({ cwd, slug: "acme", name: "Acme", modules });
      const product = await readFile(
        path.join(cwd, ".pkey/product.yaml"),
        "utf8",
      );
      expect(product).toContain("profileId: standard-defaults");
      expect(product).not.toMatch(/^\s+profile:/m);
      expect(
        await readFile(path.join(cwd, ".pkey/schema.yaml"), "utf8"),
      ).not.toContain("catalog:");
      const result = validateLoadedManifest(await loadManifest(cwd));
      expect(result.ok).toBe(true);
      expect(result.warnings).toEqual([]);
    }
  });

  it("validates a flat, djdl-shaped manifest with deprecation warnings and exit 0 (ST-19)", async () => {
    const cwd = await tempDir();
    await mkdir(path.join(cwd, ".pkey"));
    await writeFile(
      path.join(cwd, ".pkey/product.json"),
      JSON.stringify({
        slug: "djdl",
        name: "DJDL",
        compatMin: "0.0.0",
        defaultDeviceLimit: 5,
        adminGroup: "admins",
        profiles: [{ id: "default", name: "Default" }],
        tiers: [{ id: "standard", profileId: "default" }],
      }),
    );
    await writeFile(
      path.join(cwd, ".pkey/schema.json"),
      JSON.stringify({ schemaVersion: 1, entries: [] }),
    );
    const io = capture();
    await expect(runPkey(["validate"], { cwd, ...io })).resolves.toBe(0);
    expect(io.out()).toContain("Manifest: valid");
    for (const at of [
      "/slug",
      "/name",
      "/compatMin",
      "/defaultDeviceLimit",
      "/adminGroup",
      "/profiles",
      "/tiers",
    ])
      expect(io.out()).toContain(`warning product${at} (.pkey/product.json): `);
    expect(io.out()).toContain(
      "defaultDeviceLimit is a deprecated spelling; write licensing.defaultDeviceLimit.",
    );
    expect(io.out()).not.toContain("error ");
  });

  it("warns when one document exists under two extensions (ST-19, CLI only)", async () => {
    const cwd = await tempDir();
    await initManifest({
      cwd,
      slug: "acme",
      name: "Acme",
      modules: ["license", "config"],
    });
    await writeFile(
      path.join(cwd, ".pkey/product.json"),
      JSON.stringify({ product: { slug: "acme", name: "Acme" } }),
    );
    const manifest = await loadManifest(cwd);
    expect(manifest.productPath.endsWith("product.json")).toBe(true);
    expect(manifest.fileWarnings).toEqual([
      ".pkey/product.json and .pkey/product.yaml are one document; only .pkey/product.json is read (json, then yaml, then yml), here and on the platform. Keep one file.",
    ]);
    const io = capture();
    await expect(runPkey(["validate"], { cwd, ...io })).resolves.toBe(0);
    expect(io.out()).toContain(
      "warning .pkey/: .pkey/product.json and .pkey/product.yaml are one document",
    );
    // One file per document: nothing to say.
    await rm(path.join(cwd, ".pkey/product.json"));
    expect((await loadManifest(cwd)).fileWarnings).toBeUndefined();
  });

  it("--modules accepts both vocabularies and returns canonical slugs", () => {
    expect(normalizeModules(undefined)).toEqual(["license", "config"]);
    expect(normalizeModules("licensing,config")).toEqual(["license", "config"]);
    expect(normalizeModules("config, license")).toEqual(["license", "config"]);
    expect(normalizeModules("oidc,identity")).toEqual(["identity"]);
    expect(normalizeModules("releases")).toEqual([
      "release",
      "distribution",
      "update",
    ]);
    for (const name of Object.keys(MODULE_SERVICES))
      expect(() => normalizeModules(name)).not.toThrow();
    expect(() => normalizeModules("licence")).toThrow(
      `Unknown module "licence". Expected one of ${SERVICE_SLUGS.join(", ")}, licensing,`,
    );
  });

  it("fails validation when enabled releases have no release manifest", async () => {
    const cwd = await tempDir();
    await initManifest({
      cwd,
      slug: "djdl",
      name: "DJDL",
      modules: ["licensing", "releases"],
    });
    await rm(path.join(cwd, ".pkey/release.yaml"));

    const manifest = await loadManifest(cwd);
    const result = validateLoadedManifest(manifest);
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain("missing_release");
  });

  it("initializes OIDC with the platform provider and no product OIDC secret", async () => {
    const cwd = await tempDir();
    await initManifest({
      cwd,
      slug: "djdl",
      name: "DJDL",
      modules: ["licensing", "config", "oidc"],
    });

    const productYaml = await readFile(
      path.join(cwd, ".pkey/product.yaml"),
      "utf8",
    );
    expect(productYaml).toContain("provider: platform");
    expect(productYaml).not.toContain("oidc_client_secret");

    const manifest = await loadManifest(cwd);
    const result = validateLoadedManifest(manifest);
    expect(result.ok).toBe(true);
    expect(result.requiredSecrets).toEqual([]);
  });

  it("runs init and validate through the CLI entrypoint", async () => {
    const cwd = await tempDir();
    const io = capture();

    await expect(
      runPkey(
        [
          "init",
          "--product",
          "acme",
          "--name",
          "Acme",
          "--modules",
          "licensing,config",
        ],
        { cwd, ...io },
      ),
    ).resolves.toBe(0);
    expect(io.out()).toContain("Created 2 manifest files");

    const validation = capture();
    await expect(runPkey(["validate"], { cwd, ...validation })).resolves.toBe(
      0,
    );
    expect(validation.out()).toContain("Manifest: valid");
  });

  it("scaffolds a release-only product that validates and parses", async () => {
    const cwd = await tempDir();
    const io = capture();
    await expect(
      runPkey(
        [
          "init",
          "--product",
          "acme",
          "--name",
          "Acme",
          "--modules",
          "releases",
        ],
        { cwd, ...io },
      ),
    ).resolves.toBe(0);
    expect(io.out()).toContain("Created 3 manifest files");
    for (const file of ["product", "schema", "release"])
      await readFile(path.join(cwd, `.pkey/${file}.yaml`), "utf8");
    expect(
      await readFile(path.join(cwd, ".pkey/schema.yaml"), "utf8"),
    ).toContain("entries: []");

    const validation = capture();
    await expect(runPkey(["validate"], { cwd, ...validation })).resolves.toBe(
      0,
    );
    expect(validation.out()).toContain("Manifest: valid");
  });

  it("refuses a missing schema exactly as parseManifest (link/resync) does", async () => {
    const cwd = await tempDir();
    await initManifest({
      cwd,
      slug: "acme",
      name: "Acme",
      modules: ["releases"],
    });
    await rm(path.join(cwd, ".pkey/schema.yaml"));

    const validation = capture();
    await expect(runPkey(["validate"], { cwd, ...validation })).resolves.toBe(
      1,
    );

    const result = validateLoadedManifest(await loadManifest(cwd));
    expect(result.errors.map((e) => e.code)).toEqual(["missing_schema"]);

    const parsed = parseManifest({
      product: await readFile(path.join(cwd, ".pkey/product.yaml"), "utf8"),
      release: await readFile(path.join(cwd, ".pkey/release.yaml"), "utf8"),
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    const [error] = result.errors;
    expect(parsed.errors).toEqual([`${error!.file}: ${error!.message}`]);
    expect(validation.out()).toContain(`error schema/: ${error!.message}`);
  });

  it("scaffolds a tier that means five devices and no expiry", async () => {
    const cwd = await tempDir();
    await initManifest({
      cwd,
      slug: "acme",
      name: "Acme",
      modules: ["licensing", "config"],
    });
    const product = await readFile(
      path.join(cwd, ".pkey/product.yaml"),
      "utf8",
    );
    const schema = await readFile(path.join(cwd, ".pkey/schema.yaml"), "utf8");
    expect(product).not.toContain("keyActivation");

    const parsed = parseManifest({ product, schema });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.manifest.product.defaultMaxOfflineDays).toBe(14);
    expect(parsed.manifest.tiers).toHaveLength(1);
    expect(parsed.manifest.tiers[0]).toMatchObject({
      policyDeviceLimit: 5,
      policyExpiryDays: null,
    });

    const result = validateLoadedManifest(await loadManifest(cwd));
    expect(result.warnings.map((w) => w.code)).not.toContain(
      "tier_ignored_field",
    );
  });

  it("lists every service slug from the table in the init help", async () => {
    const help = capture();
    expect(await runPkey(["init", "--help"], help)).toBe(0);
    expect(help.out()).toContain(`[--modules ${SERVICE_SLUGS.join(",")}]`);
  });

  it("prints trust and SDK snippets", async () => {
    const trust = capture();
    expect(
      await runPkey(["trust", "--kid", "kid1", "--public-key", "pub1"], trust),
    ).toBe(0);
    expect(trust.out()).toContain('"kid1": "pub1"');
    expect(trust.out()).toContain(
      'const PINNED_TRUST_KEYS := {"kid1": "pub1"}',
    );

    const sdk = capture();
    expect(
      await runPkey(
        ["sdk", "--product", "djdl", "--base-url", "https://key.example"],
        sdk,
      ),
    ).toBe(0);
    expect(sdk.out()).toContain('productSlug: "djdl"');
    expect(sdk.out()).toContain('baseUrl: "https://key.example"');
  });

  it("points the Node snippet at the production origin when no --base-url is given", async () => {
    const sdk = capture();
    expect(await runPkey(["sdk", "--product", "djdl"], sdk)).toBe(0);
    expect(sdk.out()).toContain('baseUrl: "https://key.plrs.im"');
    expect(sdk.out()).not.toContain("example.com");
  });

  it("accepts JSON product manifests", async () => {
    const cwd = await tempDir();
    await writeFile(
      path.join(cwd, ".pkey/product.json"),
      JSON.stringify({
        apiVersion: "pkey.dev/v1",
        product: { slug: "json-app", name: "JSON App" },
        modules: { licensing: { enabled: true } },
        licensing: { tiers: [] },
      }),
      "utf8",
    ).catch(async (err: unknown) => {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      await initManifest({
        cwd,
        slug: "json-app",
        name: "JSON App",
        modules: ["licensing"],
      });
      await writeFile(
        path.join(cwd, ".pkey/product.json"),
        JSON.stringify({
          apiVersion: "pkey.dev/v1",
          product: { slug: "json-app", name: "JSON App" },
          modules: { licensing: { enabled: true } },
          licensing: { tiers: [] },
        }),
        "utf8",
      );
    });

    const result = validateLoadedManifest(await loadManifest(cwd));
    expect(result.ok).toBe(true);
  });
});
