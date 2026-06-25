import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  initManifest,
  loadManifest,
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
    ).toContain("catalog:");

    const manifest = await loadManifest(cwd);
    const result = validateLoadedManifest(manifest);
    expect(result.ok).toBe(true);
    expect(result.enabledModules).toEqual(["licensing", "config"]);
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

  it("prints trust and SDK snippets", async () => {
    const trust = capture();
    expect(
      await runPkey(["trust", "--kid", "kid1", "--public-key", "pub1"], trust),
    ).toBe(0);
    expect(trust.out()).toContain('"kid1": "pub1"');

    const sdk = capture();
    expect(
      await runPkey(
        ["sdk", "--product", "djdl", "--base-url", "https://key.example"],
        sdk,
      ),
    ).toBe(0);
    expect(sdk.out()).toContain('productSlug: "djdl"');
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
