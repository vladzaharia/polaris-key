/**
 * F-03 fixture packages, one per ecosystem, built in memory the way each ecosystem's packer
 * writes them (so nothing binary is committed): an npm tarball, a wheel and an sdist, a Swift
 * registry scratch directory, a Maven publication directory, an OCI image layout and a Godot
 * addon zip with its icon.
 */

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { zipStore } from "../src/zip.js";

export const sha = (b: Uint8Array | string) =>
  createHash("sha256").update(b).digest("hex");
const enc = (s: string) => new TextEncoder().encode(s);

/** A ustar archive of the given members (regular files), gzipped. */
export function tgz(members: Record<string, string | Uint8Array>): Uint8Array {
  const blocks: Buffer[] = [];
  for (const [name, content] of Object.entries(members)) {
    const data = Buffer.from(
      typeof content === "string" ? enc(content) : content,
    );
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, "utf8");
    h.write("0000644\0", 100);
    h.write("0000000\0", 108);
    h.write("0000000\0", 116);
    h.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    h.write("00000000000\0", 136);
    h.write("        ", 148);
    h.write("0", 156);
    h.write("ustar\0", 257);
    h.write("00", 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return new Uint8Array(gzipSync(Buffer.concat(blocks)));
}

const zip = (files: Record<string, string | Uint8Array>) =>
  new Uint8Array(
    zipStore(
      Object.entries(files).map(([name, data]) => ({
        name,
        data: typeof data === "string" ? enc(data) : data,
      })),
    ),
  );

export function npmPackage(version = "1.4.0"): Record<string, Uint8Array> {
  return {
    [`acme-sdk-${version}.tgz`]: tgz({
      "package/package.json": JSON.stringify({
        name: "@acme/sdk",
        version,
        description: "The Acme SDK",
        license: "MIT",
        dependencies: { "@acme/core": "^1.0.0" },
        engines: { node: ">=22" },
        exports: { ".": "./dist/index.js" },
        scripts: { postinstall: "never copied" },
      }),
      "package/dist/index.js": "export {};\n",
    }),
  };
}

export function pypiPackage(version = "1.4.0"): Record<string, Uint8Array> {
  const metadata = `Metadata-Version: 2.1\nName: Acme_SDK\nVersion: ${version}\nSummary: The Acme SDK\nRequires-Python: >=3.9\nLicense: MIT\n\nLong description.\n`;
  return {
    [`acme_sdk-${version}-py3-none-any.whl`]: zip({
      "acme_sdk/__init__.py": "",
      [`acme_sdk-${version}.dist-info/METADATA`]: metadata,
    }),
    [`acme_sdk-${version}.tar.gz`]: tgz({
      [`acme_sdk-${version}/PKG-INFO`]: metadata,
    }),
  };
}

export function swiftScratch(signed = true): Record<string, Uint8Array> {
  return {
    "AcmeKit-1.4.0.zip": zip({
      "Package.swift": "// swift-tools-version:5.9\n",
    }),
    ...(signed ? { "AcmeKit-1.4.0.sig": enc("cms signature bytes") } : {}),
    "Package.swift": enc("// swift-tools-version:5.9\n// signed\n"),
    "Package@swift-5.10.swift": enc("// swift-tools-version:5.10\n// signed\n"),
  };
}

export function mavenPublication(
  version = "1.4.0",
): Record<string, Uint8Array> {
  const stem = `acme-sdk-${version}`;
  return {
    [`${stem}.pom`]: enc(`<?xml version="1.0"?>
<project>
  <modelVersion>4.0.0</modelVersion>
  <parent><groupId>gg.parent</groupId><artifactId>parent</artifactId><version>9</version></parent>
  <groupId>gg.acme</groupId>
  <artifactId>acme-sdk</artifactId>
  <version>${version}</version>
  <packaging>aar</packaging>
  <dependencies>
    <dependency><groupId>x</groupId><artifactId>y</artifactId><version>1</version></dependency>
  </dependencies>
</project>
`),
    [`${stem}.aar`]: enc("aar bytes"),
    [`${stem}-sources.jar`]: enc("sources bytes"),
    [`${stem}.module`]: enc("{}"),
    [`${stem}.aar.sha1`]: enc("deadbeef"),
  };
}

/** An OCI image layout: index.json → an image index → two manifests → a config and a layer. */
export function ociLayout(): Record<string, Uint8Array> {
  const layer = enc("layer tarball bytes");
  const config = enc(JSON.stringify({ architecture: "amd64", os: "linux" }));
  const manifest = (arch: string) =>
    enc(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        config: {
          mediaType: "application/vnd.oci.image.config.v1+json",
          digest: `sha256:${sha(config)}`,
          size: config.length,
        },
        layers: [
          {
            mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
            digest: `sha256:${sha(layer)}`,
            size: layer.length,
            annotations: { arch },
          },
        ],
      }),
    );
  const amd = manifest("amd64");
  const arm = manifest("arm64");
  const index = enc(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: [
        {
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          digest: `sha256:${sha(amd)}`,
          size: amd.length,
          platform: { os: "linux", architecture: "amd64" },
        },
        {
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          digest: `sha256:${sha(arm)}`,
          size: arm.length,
          platform: { os: "linux", architecture: "arm64" },
        },
      ],
    }),
  );
  const blob = (b: Uint8Array) => [`image/blobs/sha256/${sha(b)}`, b] as const;
  return Object.fromEntries([
    ["image/oci-layout", enc('{"imageLayoutVersion":"1.0.0"}')],
    [
      "image/index.json",
      enc(
        JSON.stringify({
          schemaVersion: 2,
          manifests: [
            {
              mediaType: "application/vnd.oci.image.index.v1+json",
              digest: `sha256:${sha(index)}`,
              size: index.length,
            },
          ],
        }),
      ),
    ],
    blob(index),
    blob(amd),
    blob(arm),
    blob(config),
    blob(layer),
  ]);
}

export function godotAddon(version = "1.4.0"): Record<string, Uint8Array> {
  return {
    [`acme_sdk-${version}.zip`]: zip({
      "addons/acme_sdk/plugin.cfg": `[plugin]\n\nname="Acme SDK"\ndescription="Talks to \\"Acme\\""\nauthor="Acme"\nversion="${version}"\nscript="plugin.gd"\n`,
      "addons/acme_sdk/plugin.gd": "@tool\nextends EditorPlugin\n",
    }),
    "icon.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  };
}

/** A `.pkey/release` declaring one package per ecosystem (the system product has no app). */
export const PACKAGES_RELEASE_YAML = `apiVersion: pkey.dev/v1
release:
  provider:
    type: github
    owner: vladzaharia
    repo: diceroll
  binaryName: diceroll
  deliverables:
    npm.sdk:
      kind: package
      ecosystem: npm
      name: "@acme/sdk"
      artifacts:
        tarball: { match: "acme-sdk-*.tgz" }
    pypi.sdk:
      kind: package
      ecosystem: pypi
      name: acme-sdk
      artifacts:
        wheel: { match: "*.whl" }
        sdist: { match: "acme_sdk-*.tar.gz" }
    swift.kit:
      kind: package
      ecosystem: swift
      name: acme.AcmeKit
      artifacts:
        archive: { match: "AcmeKit-*.zip" }
    maven.sdk:
      kind: package
      ecosystem: maven
      name: "gg.acme:acme-sdk"
      artifacts:
        files: { match: "acme-sdk-*" }
    oci.cli:
      kind: package
      ecosystem: oci
      name: pkey
      artifacts:
        layout: { match: "oci-layout" }
    godot.sdk:
      kind: package
      ecosystem: godot
      name: acme_sdk
      artifacts:
        zip: { match: "acme_sdk-*.zip" }
        icon: { match: "icon.png" }
`;
