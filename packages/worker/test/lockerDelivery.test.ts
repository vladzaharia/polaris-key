// LK-07 (plans/LK-00.md §14.2): the Delivery surfaces (the download page, the bytes and registry
// landings) take the Polaris Locker shell while `customer.host` is on, keep the Star Cut inside as
// the Delivery symbol, and are today's bytes while it is off.
import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv } from "./seed.js";
import {
  dispatchBytesHost,
  inertDocumentPolicy,
} from "../src/core/assets/bytesHost.js";
import { dispatchRegistryHost } from "../src/core/registry/registryHost.js";
import { BYTE_ROUTES } from "../src/mount.js";
import {
  LANDING_CSS,
  LANDING_CSS_LOCKER,
  landingCsp,
  renderLandingPage,
} from "../src/core/assets/bytesLanding.js";
import { renderRegistryLandingPage } from "../src/core/registry/registryLanding.js";
import { detectPlatform } from "../src/core/platformDetect.js";
import { pageCsp } from "../src/services/distribution/page/index.js";
import {
  PAGE_CSS,
  PAGE_CSS_LOCKER,
  renderDownloadPage,
} from "../src/services/distribution/page/render.js";
import type { DownloadModel } from "../src/services/distribution/page/model.js";
import { invalidatePlatformSettings } from "../src/core/platformSettings.js";
import type { Env } from "../src/platform/env.js";
import type { SqliteDb } from "../src/db/sqlite.js";

const BYTES = "https://dl.example.test";
const PKG = "https://pkg.example.test";
const CONSOLE = "https://key.example.test";
const CUSTOMER = "https://polaris.locker";
const NOW = 1_800_000_000;

let db: SqliteDb;
let env: Env;
beforeEach(() => {
  db = makeTestDb();
  env = makeEnv(new KvMock(), []);
  env.BLOB_ORIGIN = BYTES;
  env.PKG_ORIGIN = PKG;
  env.CONSOLE_ORIGIN = CONSOLE;
  env.CUSTOMER_ORIGIN = CUSTOMER;
});
async function setMode(mode: string): Promise<void> {
  await db.run(
    "INSERT OR REPLACE INTO platform_settings (key, value_json, version, updated_at, updated_by) VALUES ('CUSTOMER_HOST', ?, 1, ?, 'test')",
    JSON.stringify(mode),
    NOW,
  );
  invalidatePlatformSettings(env, db);
}
// The dispatch seams take our Db (worker.fetch builds its own).

const bytes = () =>
  dispatchBytesHost(new Request(`${BYTES}/`), env, db, BYTE_ROUTES);
const registry = () =>
  dispatchRegistryHost(new Request(`${PKG}/`), env, db, []);

describe("the bytes and registry landings", () => {
  it("off: Polaris Key Delivery, byte for byte", async () => {
    const res = await bytes();
    expect(await res.text()).toBe(renderLandingPage(env));
    expect(res.headers.get("content-security-policy")).toBe(await landingCsp());
    expect(renderLandingPage(env)).toContain(
      "<title>Polaris Key Delivery</title>",
    );
    expect(renderLandingPage(env)).not.toContain("Locker");
  });

  it("on: the Locker shell, the Star Cut as the Delivery symbol, its own inert policy", async () => {
    await setMode("on");
    for (const [res, render] of [
      [await bytes(), renderLandingPage(env, true)],
      [await registry(), renderRegistryLandingPage(env, true)],
    ] as const) {
      const html = await res.text();
      expect(html).toBe(render);
      expect(html).toContain("<title>Delivery · Polaris Locker</title>");
      expect(html).toContain('data-brand="locker"');
      expect(html).toContain('aria-label="Polaris Locker"');
      expect(html).toContain('<p class="svc">');
      expect(html).toContain('class="sb"'); // the Star Cut, inside
      expect(html).not.toContain("Polaris Key");
      expect(html).toContain("data:image/svg+xml,");
      const csp = res.headers.get("content-security-policy")!;
      expect(csp).toBe(await landingCsp(true));
      expect(csp).not.toBe(await landingCsp());
      expect(inertDocumentPolicy(csp)).toBe(true);
      expect(html).toContain(`<style>${LANDING_CSS_LOCKER}</style>`);
    }
    expect(LANDING_CSS_LOCKER.startsWith(LANDING_CSS)).toBe(true);
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

  it("off: the page of old", () => {
    const html = renderDownloadPage(model, detected);
    expect(html).toContain("<title>Download Tidewater</title>");
    expect(html).toContain(`<style>${PAGE_CSS}</style>`);
    expect(html).not.toContain("Locker");
  });

  it("on: the Locker shell with the Star Cut as the Delivery symbol", () => {
    const html = renderDownloadPage(model, detected, { brand: "locker" });
    expect(html).toContain(
      "<title>Download Tidewater · Polaris Locker</title>",
    );
    expect(html).toContain('data-brand="locker"');
    expect(html).toContain('rel="icon"');
    expect(html).toContain(`<style>${PAGE_CSS_LOCKER}</style>`);
    expect(html).toContain('aria-label="Polaris Locker"');
    expect(html).toContain('<p class="svc">');
    expect(html).not.toContain("Polaris Key");
    expect(html).not.toMatch(/<script/i);
  });

  it("its policy names the Locker stylesheet and allows the data: favicon only then", async () => {
    const key = await pageCsp();
    const locker = await pageCsp(null, true);
    expect(key).not.toContain("img-src");
    expect(locker).toContain("img-src data:");
    expect(locker).not.toBe(key);
    expect(inertDocumentPolicy(locker)).toBe(true);
    expect(inertDocumentPolicy(key)).toBe(true);
  });
});
