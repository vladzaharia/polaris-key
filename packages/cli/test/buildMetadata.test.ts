/**
 * P2b-05 — build metadata extraction (`buildMetadata.ts`, `zip.ts`, `plist.ts`) on the tiny real
 * archives under `fixtures/build-metadata/` (made by its `make.sh`): an IPA with a binary
 * `Info.plist`, an ad-hoc-signed executable with entitlements and an app extension; an APK built
 * by aapt2 and signed by apksigner (v2 + v3); and an F-Droid `entry.jar` signed v1.
 */

import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseManifest,
  validateReleaseDescriptor,
} from "@polaris-key/manifest";
import {
  androidBuildMetadata,
  apkSignerSha256,
  iosBuildMetadata,
  MetadataError,
  machoEntitlements,
  parseAxml,
  pkcs7FirstCertificate,
} from "../src/buildMetadata.js";
import { parsePlist, PlistError } from "../src/plist.js";
import { withZip, zipStore, ZipReader, crc32 } from "../src/zip.js";
import { cleanup, tempDir } from "./publishFixture.js";

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "build-metadata",
);
const fixture = (name: string) => path.join(FIXTURES, name);
/** The test keystore's certificate SHA-256 (`make.sh` prints it). */
export const KEY_SHA256 =
  "f7cdd36513816f0cd9fce4caf4879bdfef2e39086de99f6a0cce603fcfde448a";

afterEach(cleanup);

describe("iOS metadata", () => {
  it("reads the IPA's Info.plist (binary), entitlements of the app and its extension, and privacy strings", async () => {
    expect(await iosBuildMetadata(fixture("tiny.ipa"))).toEqual({
      bundleIdentifier: "gg.vlad.diceroll",
      version: "1.2.3",
      buildVersion: "10203",
      minOSVersion: "16.0",
      appPermissions: {
        // application-identifier and the team identifier are AltStore's exclusions.
        entitlements: [
          "com.apple.developer.game-center",
          "com.apple.security.application-groups",
          "get-task-allow",
        ],
        privacy: {
          NSCameraUsageDescription: "Scan a friend's dice code.",
          NSMicrophoneUsageDescription: "Shout at your dice — “roll!”",
        },
      },
    });
  });

  it("refuses an IPA with no Payload app", async () => {
    const dir = await tempDir();
    const ipa = path.join(dir, "empty.ipa");
    await writeFile(
      ipa,
      zipStore([{ name: "README", data: new Uint8Array([1]) }]),
    );
    await expect(iosBuildMetadata(ipa)).rejects.toBeInstanceOf(MetadataError);
  });

  it("a Mach-O with no code signature has no entitlements", () => {
    const thin = Buffer.alloc(64);
    thin.writeUInt32LE(0xfeedfacf, 0);
    expect(machoEntitlements(thin)).toBeNull();
    expect(
      machoEntitlements(Buffer.from("not a binary at all, really")),
    ).toBeNull();
  });
});

describe("Android metadata", () => {
  it("reads the binary manifest, the ABIs under lib/ and the v2/v3 signer", async () => {
    expect(await androidBuildMetadata(fixture("tiny.apk"))).toEqual({
      packageName: "gg.vlad.diceroll",
      versionCode: 10203,
      versionName: "1.2.3",
      minSdk: 24,
      targetSdk: 35,
      nativecode: ["arm64-v8a", "armeabi-v7a"],
      signerSha256: KEY_SHA256,
    });
  });

  it("a v1-signed jar's signer comes from its PKCS#7 block, and is the same key", async () => {
    expect(
      await withZip(fixture("signed-entry.jar"), (z) => apkSignerSha256(z)),
    ).toBe(KEY_SHA256);
  });

  it("an unsigned archive has no signer, and an APK without one is refused", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "unsigned.apk");
    const manifest = await withZip(fixture("tiny.apk"), async (z) =>
      z.read(z.entry("AndroidManifest.xml")!),
    );
    await writeFile(
      file,
      zipStore([{ name: "AndroidManifest.xml", data: manifest }]),
    );
    expect(await withZip(file, (z) => apkSignerSha256(z))).toBeNull();
    await expect(androidBuildMetadata(file)).rejects.toThrow(/not signed/);
  });

  it("a manifest that is not compiled XML is refused", () => {
    expect(() => parseAxml(Buffer.from("<manifest/>"))).toThrow(MetadataError);
  });

  it("garbage is not mistaken for a PKCS#7 block", () => {
    expect(() =>
      pkcs7FirstCertificate(Buffer.from([0x30, 0x82, 0xff])),
    ).toThrow();
  });
});

describe("the metadata is what the descriptor validator accepts", () => {
  it("both shapes pass validateReleaseDescriptor", async () => {
    const res = parseManifest({
      product: JSON.stringify({
        slug: "diceroll",
        name: "Diceroll",
        modules: { release: { enabled: true } },
      }),
      schema: JSON.stringify({ schemaVersion: 1, catalog: [] }),
      release: JSON.stringify({
        release: {
          provider: { type: "github", owner: "vladzaharia", repo: "diceroll" },
          binaryName: "diceroll",
          deliverables: {
            app: {
              kind: "app",
              versioning: { scheme: "semver", buildNumber: "descriptor" },
              artifacts: [
                {
                  id: "ios",
                  platform: "ios",
                  arch: "arm64",
                  format: "ipa",
                  match: "*.ipa",
                },
                {
                  id: "apk",
                  platform: "android",
                  arch: "universal",
                  format: "apk",
                  match: "*.apk",
                },
              ],
            },
          },
        },
      }),
    });
    if (!res.ok) throw new Error(res.errors.join("\n"));
    const sha = "a".repeat(64);
    const build = (
      id: string,
      platform: string,
      arch: string,
      format: string,
      name: string,
      metadata: unknown,
    ) => ({
      id,
      platform,
      arch,
      format,
      metadata,
      artifacts: [
        {
          name,
          role: "payload",
          sha256: sha,
          size: 1,
          locations: [{ provider: "r2", key: `blobs/sha256/${sha}` }],
        },
      ],
    });
    const v = validateReleaseDescriptor(
      {
        descriptorVersion: 1,
        product: "diceroll",
        deliverable: "app",
        kind: "app",
        version: "1.2.3",
        builds: [
          build(
            "ios",
            "ios",
            "arm64",
            "ipa",
            "Diceroll.ipa",
            await iosBuildMetadata(fixture("tiny.ipa")),
          ),
          build(
            "apk",
            "android",
            "universal",
            "apk",
            "Diceroll.apk",
            await androidBuildMetadata(fixture("tiny.apk")),
          ),
        ],
      },
      res.manifest,
    );
    expect(v.ok ? [] : v.errors).toEqual([]);
  });
});

describe("plist", () => {
  it("parses XML, with entities, nested containers and every scalar", () => {
    const xml = `<?xml version="1.0"?><!DOCTYPE plist><plist version="1.0"><dict>
      <key>s</key><string>a &amp; b</string><key>e</key><string/>
      <key>i</key><integer>42</integer><key>r</key><real>1.5</real>
      <key>t</key><true/><key>f</key><false/>
      <key>a</key><array><string>x</string><dict/></array>
      <key>d</key><data>AAE=</data></dict></plist>`;
    expect(parsePlist(Buffer.from(xml))).toEqual({
      s: "a & b",
      e: "",
      i: 42,
      r: 1.5,
      t: true,
      f: false,
      a: ["x", {}],
      d: Buffer.from([0, 1]),
    });
  });

  it("refuses a malformed plist instead of guessing", () => {
    expect(() =>
      parsePlist(Buffer.from("<plist><dict><key>x</key></dict></plist>")),
    ).toThrow(PlistError);
    const bad = Buffer.concat([
      Buffer.from("bplist00"),
      Buffer.alloc(40, 0xff),
    ]);
    expect(() => parsePlist(bad)).toThrow(PlistError);
  });
});

describe("zip", () => {
  it("zipStore round-trips through ZipReader with correct CRCs", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "x.zip");
    const a = Buffer.from("hello");
    const b = Buffer.from(readFileSync(fixture("tiny.ipa")));
    const bytes = zipStore([
      { name: "a.txt", data: a },
      { name: "dir/b.bin", data: b },
    ]);
    await writeFile(file, bytes);
    // Deterministic: the same input gives the same bytes.
    expect(
      zipStore([
        { name: "a.txt", data: a },
        { name: "dir/b.bin", data: b },
      ]),
    ).toEqual(bytes);
    const zip = await ZipReader.open(file);
    try {
      expect(zip.entries.map((e) => e.name)).toEqual(["a.txt", "dir/b.bin"]);
      expect(await zip.read(zip.entry("a.txt")!)).toEqual(a);
      expect(await zip.read(zip.entry("dir/b.bin")!)).toEqual(b);
      expect(zip.entry("a.txt")!.crc32).toBe(crc32(a));
    } finally {
      await zip.close();
    }
  });

  it("a file that is not a ZIP is refused", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "not.zip");
    await writeFile(file, "nope");
    await expect(ZipReader.open(file)).rejects.toThrow(/not a ZIP/);
  });
});
