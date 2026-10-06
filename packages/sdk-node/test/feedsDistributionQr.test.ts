// @pkey-feature update.check release.download identity.devicecode
// SDK parity pass §3.7 (update.feedUrl), §3.8 (client.distribution) and §3.12 (qr.*).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PolarisKeyClient } from "../src/client.js";
import {
  pickPlatform,
  type DownloadModel,
} from "../src/distribution/client.js";
import { encodeQr, qr, qrRows } from "../src/qr/index.js";
import { MemStore, PINS } from "./updateFixtures.js";

const BASE = "https://key.plrs.im";
const P = `${BASE}/djdl`;
const DISCOVERY = {
  product: "djdl",
  services: {
    release: { enabled: true },
    distribution: { enabled: true },
    update: {
      enabled: true,
      endpoints: {
        appcast: `${P}/update/appcast.xml`,
        winsparkle: `${P}/update/{channel}/winsparkle.xml`,
        velopack: `${P}/update/{channel}/velopack/releases.{velopackChannel}.json`,
        appInstaller: `${P}/update/{channel}/app.appinstaller`,
        zsync: `${P}/update/{channel}/{buildId}.AppImage.zsync`,
      },
    },
  },
};

const MODEL: DownloadModel = {
  schemaVersion: 1,
  product: { slug: "djdl", name: "DJDL" },
  channel: "stable",
  pageUrl: "https://dl.plrs.im/djdl",
  listing: {
    name: "DJDL",
    subtitle: null,
    description: null,
    developerName: null,
    website: null,
  },
  release: null,
  platforms: [
    {
      platform: "macos",
      label: "macOS",
      primary: "download:direct:macos",
      actions: ["download:direct:macos", "homebrew:brew"],
      builds: [],
    },
    {
      platform: "windows",
      label: "Windows",
      primary: null,
      actions: [],
      builds: [],
    },
  ],
  actions: [
    {
      id: "download:direct:macos",
      kind: "download",
      outletId: "direct",
      platforms: ["macos"],
      label: "Download",
      url: "https://dl.plrs.im/x.dmg",
      deepLink: null,
      qr: null,
      command: null,
      fingerprint: null,
      version: "1.0.0",
      build: null,
    },
    {
      id: "homebrew:brew",
      kind: "homebrew",
      outletId: "brew",
      platforms: ["macos"],
      label: "Homebrew",
      url: null,
      deepLink: null,
      qr: null,
      command: "brew install djdl",
      fingerprint: null,
      version: null,
      build: null,
    },
  ],
  keys: [],
};

async function client() {
  return PolarisKeyClient.create({
    productSlug: "djdl",
    baseUrl: BASE,
    version: "1.0.0",
    channel: "beta",
    trust: { pinnedKeys: PINS },
    store: new MemStore("dev_feeds"),
    expectedServices: ["release", "distribution", "update"] as never,
    fetchImpl: (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/polaris.json"))
        return new Response(JSON.stringify(DISCOVERY));
      if (path.endsWith("/distribution/download.json"))
        return new Response(JSON.stringify(MODEL));
      return new Response("", { status: 404 });
    }) as typeof fetch,
  });
}

describe("update.feedUrl (§3.7)", () => {
  it("expands every published template from discovery", async () => {
    const c = await client();
    expect(await c.update.feedUrl("appcast")).toEqual({
      supported: true,
      url: `${P}/update/beta/appcast.xml`,
    });
    expect(
      await c.update.feedUrl("appcast", { channel: "stable", arch: "x86_64" }),
    ).toEqual({
      supported: true,
      url: `${P}/update/appcast.xml?arch=x86_64`,
    });
    expect(await c.update.feedUrl("winsparkle")).toEqual({
      supported: true,
      url: `${P}/update/beta/winsparkle.xml`,
    });
    expect(
      await c.update.feedUrl("velopack", { velopackChannel: "win-x64" }),
    ).toEqual({
      supported: true,
      url: `${P}/update/beta/velopack/releases.win-x64.json`,
    });
    expect(await c.update.feedUrl("appInstaller")).toEqual({
      supported: true,
      url: `${P}/update/beta/app.appinstaller`,
    });
    expect(
      await c.update.feedUrl("zsync", { buildId: "linux-appimage" }),
    ).toEqual({
      supported: true,
      url: `${P}/update/beta/linux-appimage.AppImage.zsync`,
    });
  });

  it("a missing input or template is the typed Unsupported (product)", async () => {
    const c = await client();
    expect(await c.update.feedUrl("velopack")).toMatchObject({
      supported: false,
      reason: "product",
    });
  });
});

describe("client.distribution (§3.8)", () => {
  it("reads the download model and resolves this platform first", async () => {
    const c = await client();
    const model = await c.distribution.downloadModel();
    expect(model.product.name).toBe("DJDL");
    const mac = await c.distribution.thisPlatform({ platform: "macos" });
    expect(mac.primary?.label).toBe("Download");
    expect(mac.actions.map((a) => a.kind)).toEqual(["download", "homebrew"]);
    expect(mac.alsoOn).toEqual([{ platform: "windows", label: "Windows" }]);
    expect(pickPlatform(model, "linux").primary).toBeNull();
  });
});

describe("qr (§3.12)", () => {
  const fixtures = JSON.parse(
    readFileSync(
      join(
        __dirname,
        "..",
        "..",
        "..",
        "sdks",
        "godot",
        "tests",
        "qr",
        "fixtures.json",
      ),
      "utf8",
    ),
  ) as {
    cases: {
      text: string;
      forcedVersion: number | null;
      forcedMask: number | null;
      version: number;
      mask: number;
      rows: string[];
    }[];
  };

  it("matches the reference encoder (qrcodegen) on every Godot fixture", () => {
    for (const c of fixtures.cases) {
      const at = encodeQr(c.text, c.forcedVersion ?? 1, c.mask)!;
      expect(at.version, c.text).toBe(c.version);
      expect(qrRows(at), c.text).toEqual(c.rows);
      if (c.forcedMask === null && c.forcedVersion === null)
        expect(qr.rows(c.text)).toEqual(c.rows);
    }
  });

  it("renders SVG and terminal text, and refuses text over 213 bytes", () => {
    const url =
      "https://key.plrs.im/djdl/identity/auth/device?user_code=WDJB-MJHT";
    const svg = qr.svg(url, { label: 'Scan "me"' })!;
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    expect(svg).toContain('aria-label="Scan &quot;me&quot;"');
    const term = qr.terminal(url)!;
    const size = encodeQr(url)!.size + 4;
    expect(term.split("\n")).toHaveLength(Math.ceil(size / 2));
    expect(term.split("\n")[0]).toHaveLength(size);
    expect(qr.svg("x".repeat(214))).toBeNull();
    expect(qr.terminal("x".repeat(214))).toBeNull();
  });
});
