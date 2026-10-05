/**
 * F-03 — `pkey release publish --deliverable <package id>`: the six extractors over fixture
 * packages, the descriptor they produce (validated by the Worker's own validator), the publish
 * flow (always a dry run first), the old-Worker guard, and the dispatch from the CLI and the
 * Action.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseManifest,
  validateReleaseDescriptor,
} from "@polaris-key/manifest";
import { runPkey } from "../src/index.js";
import { extractPackage } from "../src/package/extract.js";
import { PREDATES_PACKAGES } from "../src/package/publish.js";
import { runAction } from "../src/action.js";
import {
  actionsEnv,
  BASE,
  capture,
  cleanup,
  fakeServer,
  json,
  repo,
  SLUG,
} from "./publishFixture.js";
import {
  cargoCrate,
  godotAddon,
  mavenPublication,
  npmPackage,
  ociLayout,
  PACKAGES_RELEASE_YAML,
  pypiPackage,
  sha,
  swiftScratch,
} from "./packageFixtures.js";

afterEach(cleanup);
const instant = async () => {};

async function extractIn(
  files: Record<string, Uint8Array>,
  id: string,
  version?: string,
) {
  const cwd = await repo(files, PACKAGES_RELEASE_YAML);
  const res = parseManifest({
    product: `slug: ${SLUG}\nname: Diceroll\n`,
    schema: "schemaVersion: 1\ncatalog: []\n",
    release: PACKAGES_RELEASE_YAML,
  } as never);
  if (!res.ok) throw new Error(res.errors.join("\n"));
  const decl = res.manifest.release!.packageDeliverables.find(
    (p) => p.id === id,
  )!;
  const workDir = await mkdtemp(path.join(os.tmpdir(), "pkey-work-"));
  try {
    return await extractPackage(decl.ecosystem, {
      declaration: decl,
      dir: path.join(cwd, "dist"),
      workDir,
      ...(version ? { version } : {}),
    });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

describe("the package extractors (F-03, F-30)", () => {
  it("npm: the tarball, and package.json's name, version and packument fields (never scripts)", async () => {
    const x = await extractIn(npmPackage(), "npm.sdk");
    expect(x.version).toBe("1.4.0");
    expect(x.files.map((f) => [f.name, f.type])).toEqual([
      ["acme-sdk-1.4.0.tgz", "npm-tarball"],
    ]);
    expect(x.metadata).toEqual({
      name: "@acme/sdk",
      version: "1.4.0",
      description: "The Acme SDK",
      license: "MIT",
      dependencies: { "@acme/core": "^1.0.0" },
      engines: { node: ">=22" },
      exports: { ".": "./dist/index.js" },
    });
  });

  it("PyPI: the wheel, its METADATA as a core-metadata file, the sdist, Requires-Python", async () => {
    const x = await extractIn(pypiPackage(), "pypi.sdk");
    expect(x.files.map((f) => [f.name, f.type])).toEqual([
      ["acme_sdk-1.4.0-py3-none-any.whl", "wheel"],
      ["acme_sdk-1.4.0-py3-none-any.whl.metadata", "core-metadata"],
      ["acme_sdk-1.4.0.tar.gz", "sdist"],
    ]);
    expect(x.metadata).toEqual({
      name: "acme-sdk",
      version: "1.4.0",
      summary: "The Acme SDK",
      requiresPython: ">=3.9",
      license: "MIT",
    });
  });

  it("Swift: the source archive, its signature and the signed manifests; the version is --version's", async () => {
    const x = await extractIn(swiftScratch(), "swift.kit", "1.4.0");
    expect(x.files.map((f) => [f.name, f.type])).toEqual([
      ["AcmeKit-1.4.0.zip", "source-archive"],
      ["AcmeKit-1.4.0.sig", "source-archive-signature"],
      ["Package.swift", "manifest"],
      ["Package@swift-5.10.swift", "manifest"],
    ]);
    expect(x.metadata).toEqual({
      name: "acme.AcmeKit",
      version: "1.4.0",
      toolsVersions: ["5.10"],
      signatureFormat: "cms-1.0.0",
    });
    await expect(extractIn(swiftScratch(), "swift.kit")).rejects.toThrow(
      /pass --version/,
    );
  });

  it("Maven: every publication file with its extension and classifier, never a checksum sidecar", async () => {
    const x = await extractIn(mavenPublication(), "maven.sdk");
    expect(
      x.files.map((f) => [f.name, f.extension, f.classifier ?? null]),
    ).toEqual([
      ["acme-sdk-1.4.0-sources.jar", "jar", "sources"],
      ["acme-sdk-1.4.0.aar", "aar", null],
      ["acme-sdk-1.4.0.module", "module", null],
      ["acme-sdk-1.4.0.pom", "pom", null],
    ]);
    expect(x.metadata).toEqual({
      name: "gg.acme:acme-sdk",
      version: "1.4.0",
      groupId: "gg.acme",
      artifactId: "acme-sdk",
      packaging: "aar",
    });
  });

  it("OCI: every reachable blob, typed and named by digest, the root and the platforms", async () => {
    const files = ociLayout();
    const x = await extractIn(files, "oci.cli", "1.4.0");
    const types = Object.fromEntries(x.files.map((f) => [f.type, 0]));
    expect(Object.keys(types).sort()).toEqual([
      "oci-blob",
      "oci-index",
      "oci-manifest",
    ]);
    expect(x.files).toHaveLength(5);
    expect(x.files.every((f) => /^sha256:[0-9a-f]{64}$/.test(f.name))).toBe(
      true,
    );
    expect(x.metadata).toMatchObject({
      name: "pkey",
      version: "1.4.0",
      mediaType: "application/vnd.oci.image.index.v1+json",
      platforms: ["linux/amd64", "linux/arm64"],
    });
    expect(String(x.metadata.root)).toBe(
      x.files.find((f) => f.type === "oci-index")!.name,
    );
  });

  it("Godot: the addon zip and its icon, plugin.cfg's version, name, author and script", async () => {
    const x = await extractIn(godotAddon(), "godot.sdk");
    expect(x.files.map((f) => [f.name, f.type])).toEqual([
      ["acme_sdk-1.4.0.zip", "godot-zip"],
      ["icon.png", "godot-icon"],
    ]);
    expect(x.metadata).toEqual({
      name: "acme_sdk",
      version: "1.4.0",
      displayName: "Acme SDK",
      author: "Acme",
      description: 'Talks to "Acme"',
      script: "plugin.gd",
    });
  });

  it("Cargo: the crate, and its normalised Cargo.toml's dependencies, features, links and rust-version", async () => {
    const x = await extractIn(cargoCrate(), "cargo.sdk");
    expect(x.files.map((f) => [f.name, f.type])).toEqual([
      ["acme-sdk-1.4.0.crate", "crate"],
    ]);
    expect(x.version).toBe("1.4.0");
    expect(x.metadata).toEqual({
      name: "acme-sdk",
      version: "1.4.0",
      description: "The Acme SDK",
      license: "MIT",
      rustVersion: "1.74",
      links: "acme",
      deps: [
        {
          name: "serde",
          req: "^1.0",
          features: ["derive"],
          optional: true,
          default_features: true,
          target: null,
          kind: "normal",
          registry: null,
        },
        {
          name: "acme-core",
          req: "^0.3",
          features: [],
          optional: false,
          default_features: true,
          target: null,
          kind: "normal",
          registry: "sparse+https://pkg.plrs.im/cargo/acme/",
        },
        {
          name: "json",
          req: "1",
          features: [],
          optional: false,
          default_features: false,
          target: null,
          kind: "normal",
          registry: null,
          package: "serde_json",
        },
        {
          name: "proptest",
          req: "1",
          features: [],
          optional: false,
          default_features: true,
          target: null,
          kind: "dev",
          registry: null,
        },
        {
          name: "libc",
          req: "0.2",
          features: [],
          optional: false,
          default_features: true,
          target: "cfg(unix)",
          kind: "normal",
          registry: null,
        },
      ],
      features: { default: ["std"], std: [], serde: ["dep:serde"] },
    });
  });

  it("Cargo: refuses a manifest cargo package has not normalised", async () => {
    const { tgz } = await import("./packageFixtures.js");
    const local = {
      "acme-sdk-1.4.0.crate": tgz({
        "acme-sdk-1.4.0/Cargo.toml":
          '[package]\nname = "acme-sdk"\nversion = "1.4.0"\n\n[dependencies.core]\nversion = "1"\nregistry = "acme"\n',
      }),
    };
    await expect(extractIn(local, "cargo.sdk")).rejects.toThrow(
      /by its local name/,
    );
    const git = {
      "acme-sdk-1.4.0.crate": tgz({
        "acme-sdk-1.4.0/Cargo.toml":
          '[package]\nname = "acme-sdk"\nversion = "1.4.0"\n\n[dependencies]\ncore = { git = "https://example.com/core" }\n',
      }),
    };
    await expect(extractIn(git, "cargo.sdk")).rejects.toThrow(/git dependency/);
    const other = {
      "acme-sdk-1.4.0.crate": tgz({
        "acme-sdk-1.4.0/Cargo.toml":
          '[package]\nname = "Acme-SDK"\nversion = "1.4.0"\n',
      }),
    };
    await expect(extractIn(other, "cargo.sdk")).rejects.toThrow(
      /packs Acme-SDK/,
    );
  });

  it("refuses files that name another package", async () => {
    const wrong = {
      "acme-sdk-1.4.0.tgz": (await import("./packageFixtures.js")).tgz({
        "package/package.json": JSON.stringify({
          name: "@evil/sdk",
          version: "1.4.0",
        }),
      }),
    };
    await expect(extractIn(wrong, "npm.sdk")).rejects.toThrow(/@evil\/sdk/);
  });
});

function argv(id: string, extra: string[] = []) {
  return [
    "release",
    "publish",
    "--product",
    SLUG,
    "--deliverable",
    id,
    "--dir",
    "dist",
    "--base-url",
    BASE,
    ...extra,
  ];
}

async function run(cwd: string, args: string[], server = fakeServer()) {
  const io = capture();
  const code = await runPkey(args, {
    cwd,
    stdout: io.stdout,
    stderr: io.stderr,
    env: actionsEnv(),
    fetchImpl: server.fetchImpl,
    sleep: instant,
  });
  return { code, out: io.out(), err: io.err(), server };
}

describe("pkey release publish --deliverable <package> (F-03)", () => {
  it("validates locally, dry-runs on the server first, uploads, then submits a kind: package descriptor with no record", async () => {
    const cwd = await repo(npmPackage(), PACKAGES_RELEASE_YAML);
    const { code, err, server } = await run(
      cwd,
      argv("npm.sdk", ["--channel", "stable"]),
    );
    expect(code, err).toBe(0);
    const submits = server.to("/release/publish/submit");
    expect(submits).toHaveLength(2);
    expect((submits[0]!.body as { dryRun?: boolean }).dryRun).toBe(true);
    const final = submits[1]!.body as Record<string, any>;
    expect(final.dryRun).toBeUndefined();
    expect(final.record).toBeUndefined();
    const d = final.descriptor;
    expect(d).toMatchObject({
      kind: "package",
      deliverable: "npm.sdk",
      version: "1.4.0",
      channel: "stable",
      seq: 7,
      package: { ecosystem: "npm", name: "@acme/sdk" },
    });
    const tgzSha = sha(npmPackage()["acme-sdk-1.4.0.tgz"]!);
    expect(d.package.files[0]).toMatchObject({
      sha256: tgzSha,
      type: "npm-tarball",
      locations: [{ provider: "r2", key: `blobs/sha256/${tgzSha}` }],
    });
    // The upload went to R2 between the dry run and the submit.
    expect(server.r2.has(`staging/${SLUG}/t1/${tgzSha}`)).toBe(true);
    // The descriptor is exactly what the Worker's validator accepts.
    const res = parseManifest({
      product: `slug: ${SLUG}\nname: Diceroll\n`,
      schema: "schemaVersion: 1\ncatalog: []\n",
      release: PACKAGES_RELEASE_YAML,
    } as never);
    if (!res.ok) throw new Error(res.errors.join("\n"));
    const v = validateReleaseDescriptor(d, {
      product: { slug: SLUG },
      release: {
        app: null,
        packages: res.manifest.release!.packageDeliverables,
      },
    });
    expect(v.ok ? [] : v.errors).toEqual([]);
  });

  it("stops before uploading anything when the Worker predates package releases", async () => {
    const cwd = await repo(npmPackage(), PACKAGES_RELEASE_YAML);
    const server = fakeServer();
    server.script("/submit", () =>
      json(
        {
          error: "invalid_descriptor",
          reason: "invalid_descriptor",
          message: "/kind: kind must be app.",
          errors: [
            {
              path: "/kind",
              code: "invalid_descriptor",
              message: "kind must be app.",
            },
          ],
        },
        400,
      ),
    );
    const { code, err } = await run(cwd, argv("npm.sdk"), server);
    expect(code).toBe(1);
    expect(err).toContain(PREDATES_PACKAGES);
    expect(server.r2.size).toBe(0);
    expect(server.to("/release/publish/submit")).toHaveLength(1);
  });

  it("--dry-run asks the server and uploads nothing", async () => {
    const cwd = await repo(npmPackage(), PACKAGES_RELEASE_YAML);
    const { code, out, server } = await run(
      cwd,
      argv("npm.sdk", ["--dry-run"]),
    );
    expect(code).toBe(0);
    expect(out).toContain("Dry run: nothing uploaded");
    expect(server.r2.size).toBe(0);
    expect(server.to("/release/publish/submit")).toHaveLength(1);
  });

  it("refuses a --version the files do not carry, and the app's and packs' flags", async () => {
    const cwd = await repo(npmPackage(), PACKAGES_RELEASE_YAML);
    const wrongVersion = await run(
      cwd,
      argv("npm.sdk", ["--version", "2.0.0"]),
    );
    expect(wrongVersion.code).toBe(1);
    expect(wrongVersion.err).toMatch(
      /does not match the packed files' version 1\.4\.0/,
    );
    const tagged = await run(cwd, argv("npm.sdk", ["--tag", "v1.4.0"]));
    expect(tagged.code).toBe(1);
    expect(tagged.err).toMatch(/--tag does not apply here/);
  });

  it("publishes every fixture ecosystem's descriptor through the local validator", async () => {
    const cases: Array<[string, Record<string, Uint8Array>, string[]]> = [
      ["pypi.sdk", pypiPackage(), []],
      ["swift.kit", swiftScratch(), ["--version", "1.4.0"]],
      ["maven.sdk", mavenPublication(), []],
      ["oci.cli", ociLayout(), ["--version", "1.4.0"]],
      ["godot.sdk", godotAddon(), []],
      ["cargo.sdk", cargoCrate(), []],
    ];
    for (const [id, files, extra] of cases) {
      const cwd = await repo(files, PACKAGES_RELEASE_YAML);
      const { code, err, server } = await run(cwd, argv(id, extra));
      expect(code, `${id}: ${err}`).toBe(0);
      const final = server.to("/release/publish/submit")[1]!.body as Record<
        string,
        any
      >;
      expect(final.descriptor.kind, id).toBe("package");
    }
  });

  it("the Action dispatches a package deliverable to the package publish", async () => {
    const cwd = await repo(npmPackage(), PACKAGES_RELEASE_YAML);
    const server = fakeServer();
    const io = capture();
    const outputs = path.join(cwd, "gh-output");
    await writeFile(outputs, "");
    const code = await runAction({
      cwd,
      env: {
        ...actionsEnv(),
        INPUT_PRODUCT: SLUG,
        INPUT_DIR: "dist",
        INPUT_DELIVERABLE: "npm.sdk",
        "INPUT_BASE-URL": BASE,
        GITHUB_OUTPUT: outputs,
      },
      stdout: io.stdout,
      stderr: io.stderr,
      fetchImpl: server.fetchImpl,
      sleep: instant,
    } as never);
    expect(code, io.err()).toBe(0);
    const final = server.to("/release/publish/submit")[1]!.body as Record<
      string,
      any
    >;
    expect(final.descriptor.kind).toBe("package");
  });
});
