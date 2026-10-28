// LK-07 (plans/LK-00.md §14.2; hard cutover): the Delivery surfaces (the download page, the bytes
// and registry landings) wear the Polaris Locker shell, with the Star Cut inside as the Delivery
// symbol.
import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../helpers.js";
import { KvMock } from "../../kvMock.js";
import { makeEnv } from "../../seed.js";
import {
  dispatchBytesHost,
  inertDocumentPolicy,
} from "../../../src/core/assets/bytesHost.js";
import { dispatchRegistryHost } from "../../../src/core/registry/registryHost.js";
import { BYTE_ROUTES } from "../../../src/mount.js";
import {
  landingCsp,
  renderLandingPage,
} from "../../../src/core/assets/bytesLanding.js";
import {
  registryLandingCsp,
  renderRegistryLandingPage,
} from "../../../src/core/registry/registryLanding.js";
import { detectPlatform } from "../../../src/core/platformDetect.js";
import { pageCsp } from "../../../src/services/distribution/page/index.js";
import { renderDownloadPage } from "../../../src/services/distribution/page/render.js";
import type { DownloadModel } from "../../../src/services/distribution/page/model.js";

const env = makeEnv(new KvMock(), []);
env.BLOB_ORIGIN = "https://dl.example.test";
env.PKG_ORIGIN = "https://pkg.example.test";
env.CONSOLE_ORIGIN = "https://key.example.test";
const db = makeTestDb();

describe("the bytes and registry landings", () => {
  it("the download host is Polaris Locker (a customer surface), under an inert policy", async () => {
    const res = await dispatchBytesHost(
      new Request("https://dl.example.test/"),
      env,
      db,
      BYTE_ROUTES,
    );
    const html = await res.text();
    expect(html).toBe(renderLandingPage(env));
    expect(html).toContain("<title>Downloads · Polaris Locker</title>");
    expect(html).toContain('data-brand="locker"');
    expect(html).toContain('aria-label="Polaris Locker"');
    expect(html).not.toContain('<div class="svc">');
    expect(html).not.toContain("Polaris Key");
    expect(html).toContain("data:image/svg+xml,");
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toBe(await landingCsp());
    expect(inertDocumentPolicy(csp)).toBe(true);
  });

  it("the package registry is Polaris Key (developer-facing), under an inert policy", async () => {
    const res = await dispatchRegistryHost(
      new Request("https://pkg.example.test/"),
      env,
      db,
      [],
    );
    const html = await res.text();
    expect(html).toBe(renderRegistryLandingPage(env));
    expect(html).toContain("<title>Package registry · Polaris Key</title>");
    expect(html).toContain('data-brand="key"');
    expect(html).toContain('aria-label="Polaris Key"');
    expect(html).not.toContain("Polaris Locker");
    expect(html).toContain("data:image/svg+xml,");
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toBe(await registryLandingCsp());
    expect(inertDocumentPolicy(csp)).toBe(true);
  });
});

describe("the download page", () => {
  const model: DownloadModel = {
    schemaVersion: 1,
    product: { slug: "tidewater", name: "Tidewater" },
    channel: "stable",
    pageUrl: null,
    listing: {
      name: "Tidewater",
      subtitle: null,
      description: null,
      developerName: "Tidewater Studio",
      website: null,
    },
    release: null,
    platforms: [
      {
        platform: "windows",
        label: "Windows",
        primary: "a",
        actions: ["a"],
        builds: [],
      },
    ],
    actions: [
      {
        id: "a",
        kind: "download",
        outletId: "direct",
        platforms: ["windows"],
        label: "Download",
        url: "https://dl.example.test/tidewater/files/r1/t.exe",
        deepLink: null,
        qr: null,
        command: null,
        fingerprint: null,
        version: "1.0.0",
        build: {
          name: "t.exe",
          url: "https://dl.example.test/tidewater/files/r1/t.exe",
          size: 10,
          sha256: "a".repeat(64),
          version: "1.0.0",
          releaseId: "r1",
          platform: "windows",
          arch: "x64",
          minOs: null,
        },
      },
    ] as unknown as DownloadModel["actions"],
    keys: [],
  };
  const detected = detectPlatform(
    new Headers({ "user-agent": "Windows NT 10.0" }),
  );

  it("carries the Available on Polaris Locker badge, linked, only with a customer site and a direct download (LK-12)", () => {
    const url = "https://polaris.locker/tidewater";
    const html = renderDownloadPage(model, detected, { lockerUrl: url });
    expect(
      html.match(/<a href="https:\/\/polaris\.locker\/tidewater"/g),
    ).toHaveLength(3);
    expect(html).toContain('aria-label="Available on Polaris Locker"');
    expect(html).toContain('viewBox="0 0 320 104"');
    expect(html).toContain('width="320"');
    expect(html).not.toContain("style=");
    expect(renderDownloadPage(model, detected)).not.toContain(
      'class="lk-badge"',
    );
    expect(
      renderDownloadPage(model, detected, { lockerUrl: "javascript:alert(1)" }),
    ).not.toContain('class="lk-badge"');
    const noDirect = {
      ...model,
      platforms: [{ ...model.platforms[0]!, actions: [] }],
    } as DownloadModel;
    expect(
      renderDownloadPage(noDirect, detected, { lockerUrl: url }),
    ).not.toContain('class="lk-badge"');
  });

  it("is the Locker shell with the Star Cut as the Delivery symbol", () => {
    const html = renderDownloadPage(model, detected);
    expect(html).toContain(
      "<title>Download Tidewater · Polaris Locker</title>",
    );
    expect(html).toContain('data-brand="locker"');
    expect(html).toContain('rel="icon"');
    expect(html).toContain('aria-label="Polaris Locker"');
    // Customer-facing: no Delivery service row, neutral links with the coral underline.
    expect(html).not.toContain('<div class="svc">');
    expect(html).not.toContain("--accent");
    expect(html).toContain("Polaris Locker · Questions about Tidewater?");
    expect(html).toContain("Download from Polaris Locker");
    expect(html).not.toContain("Polaris Key");
    expect(html).not.toMatch(/<script/i);
  });

  it("its policy stays inert and allows the data: favicon", async () => {
    const csp = await pageCsp();
    expect(csp).toContain("img-src data:");
    expect(inertDocumentPolicy(csp)).toBe(true);
    expect(await pageCsp("https://img.example.test")).toContain(
      "img-src data: https://img.example.test",
    );
  });
});
