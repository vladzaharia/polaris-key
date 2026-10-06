import { describe, expect, it } from "vitest";
import type { SigningKeyDto } from "../src/api.js";
import {
  SDK_OPTIONS,
  sdkInit,
  sdkInstall,
  trustPins,
} from "../src/console/pages/core/sdkQuickStart.js";

const key = (kid: string, status: string): SigningKeyDto => ({
  kid,
  status,
  alg: "EdDSA",
  publicKey: `PUB-${kid}`,
  createdAt: 1,
  activateAfter: null,
  activatedAt: null,
  retiredAt: null,
  revokedAt: null,
});

const input = {
  slug: "tonebox",
  origin: "https://key.plrs.im",
  pins: [
    { kid: "tb-a", publicKey: "PUB-A" },
    { kid: "tb-b", publicKey: "PUB-B" },
  ],
  services: ["license", "config"] as const,
};

describe("SDK quick start: install (D17)", () => {
  it("every SDK installs from pkg.plrs.im, its namespace routed there first", () => {
    for (const { value } of SDK_OPTIONS) {
      const snippets = sdkInstall(value);
      expect(snippets.length, value).toBeGreaterThan(0);
      expect(snippets[0]!.code, value).toContain("https://pkg.plrs.im/");
      for (const s of snippets) {
        expect(s.code, value).not.toMatch(/registry\.npmjs\.org|pypi\.org/);
        expect(s.code, value).not.toContain("--extra-index-url");
      }
    }
  });

  it("Node routes the @polaris-key scope before npm install", () => {
    const [npmrc, install] = sdkInstall("node");
    expect(npmrc!.filename).toBe(".npmrc");
    expect(npmrc!.code).toBe(
      "@polaris-key:registry=https://pkg.plrs.im/npm/polaris-key/",
    );
    expect(install!.code).toBe("npm install @polaris-key/node");
  });
});

describe("SDK quick start: trust pins (D16)", () => {
  it("pins every active and staged key, active first, never a retired one", () => {
    expect(
      trustPins(
        [key("c", "retired"), key("b", "staged"), key("a", "active")],
        null,
      ),
    ).toEqual([
      { kid: "a", publicKey: "PUB-a" },
      { kid: "b", publicKey: "PUB-b" },
    ]);
  });

  it("falls back to the product's active key while the inventory is unread", () => {
    expect(trustPins(undefined, { kid: "a", publicKey: "PUB" })).toEqual([
      { kid: "a", publicKey: "PUB" },
    ]);
    expect(trustPins([], { kid: "a" })).toEqual([]);
  });
});

describe("SDK quick start: initialise", () => {
  it("every snippet carries every pin and no base URL on production", () => {
    for (const { value } of SDK_OPTIONS) {
      const { code } = sdkInit(value, input);
      expect(code, value).not.toContain("key.plrs.im");
      if (value === "react") continue; // the browser provider takes no pins
      expect(code, value).toContain("PUB-A");
      expect(code, value).toContain("PUB-B");
    }
  });

  it("names the base URL off production", () => {
    const { code } = sdkInit("python", {
      ...input,
      origin: "https://key-staging.plrs.im",
    });
    expect(code).toContain('base_url="https://key-staging.plrs.im",');
  });

  it("uses a placeholder for the app's own version", () => {
    for (const sdk of ["node", "python", "swift", "kotlin"] as const)
      expect(sdkInit(sdk, input).code, sdk).toContain(
        "your app's version, not Polaris Key's",
      );
    expect(sdkInit("godot", input).code).not.toMatch(/^version/m);
  });

  it("Swift imports the module", () => {
    expect(sdkInit("swift", input).code).toMatch(/^import PolarisKey\n/);
  });

  it("Godot is a complete resource: header, ext_resource, script, typed values", () => {
    const { code, filename } = sdkInit("godot", input);
    expect(filename).toBe("polaris_key.tres");
    expect(code).toBe(
      [
        '[gd_resource type="Resource" script_class="PKeyOptions" load_steps=2 format=3]',
        "",
        '[ext_resource type="Script" path="res://addons/polaris_key/core/options.gd" id="1"]',
        "",
        "[resource]",
        'script = ExtResource("1")',
        'product = "tonebox"',
        "pinned_trust_keys = {",
        '"tb-a": "PUB-A",',
        '"tb-b": "PUB-B"',
        "}",
        'expected_services = PackedStringArray("license", "config")',
      ].join("\n"),
    );
  });
});
