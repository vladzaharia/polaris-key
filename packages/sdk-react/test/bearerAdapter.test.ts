// @vitest-environment node
//
// @pkey-feature core.store core.cache devices.manage devices.report license.activate
// @pkey-feature license.entitlements identity.devicecode commerce.receipt
//
// Bearer mode through the browser ADAPTER (SDK-PARITY-PASS §3.17, SP-R02): what the transcript
// replayer cannot see because it drives the engine directly — the `auth` option, the typed
// refusals a cookie page gives for a bearer-only verb, the IndexedDB store surviving a reload by
// RE-VERIFYING what it holds, and the gate the adapter projects. Node environment, because
// jsdom's cross-realm typed arrays make WebCrypto's Ed25519 verify reject every signature.

import { describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  BrowserAdapter,
  browserAdapter,
  resolveAuthMode,
} from "../src/browser/browserAdapter.js";
import { indexedDbStore } from "../src/browser/bearer/store.js";
import { indexedDbOfflineStore } from "../src/browser/offline.js";
import { browserFacts } from "../src/browser/bearer/facts.js";
import { Feature } from "../src/constants.generated.js";
import type { PolarisAdapter } from "../src/core/index.js";
import {
  discoveryBody,
  newTestKey,
  services,
  signCompact,
} from "./fixtures.js";

const NOW = 1_700_000_000;
const DEVICE = "BEARERDEVICE00000000000000000001";
const BASE = "https://key.plrs.im";

async function settled(adapter: PolarisAdapter): Promise<void> {
  for (let i = 0; i < 200 && adapter.snapshot().phase === "loading"; i += 1)
    await new Promise((r) => setTimeout(r, 2));
}

interface Seen {
  method: string;
  path: string;
  headers: Record<string, string>;
  credentials?: RequestCredentials;
}

async function server(opts: { registration?: string } = {}) {
  const key = await newTestKey("pkey-test-bearer");
  const claims = {
    iss: "key.plrs.im",
    aud: "acme",
    deviceId: DEVICE,
    issuedAt: NOW - 10,
    expiresAt: NOW + 3600,
    graceUntil: NOW + 86400,
  };
  const license = await signCompact(
    {
      ...claims,
      licenseId: "lic-1",
      entitlements: {
        pro: { state: "enforced", value: true, updatedAt: NOW - 20 },
        seats: { state: "enforced", value: 5, updatedAt: NOW - 20 },
      },
      profile: { name: "Ada", email: "ada@acme.test", activatedAt: NOW - 100 },
    },
    key,
    "pkey-license+jws",
  );
  const config = await signCompact(
    {
      ...claims,
      schemaVersion: 1,
      secrets: {},
      config: {
        "ui.theme": { state: "default", value: "dark", updatedAt: NOW - 20 },
      },
    },
    key,
    "pkey-config+jws",
  );
  const seen: Seen[] = [];
  let licenseStatus = 200;
  const disc = JSON.parse(
    discoveryBody(services("license", "config", "identity", "distribution")),
  );
  disc.core = { registration: opts.registration ?? "requires-license" };
  const fetchImpl = (async (
    input: RequestInfo | URL,
    init: RequestInit = {},
  ) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(
        ([k, v]) => [k.toLowerCase(), v],
      ),
    );
    seen.push({
      method: init.method ?? "GET",
      path: url.pathname,
      headers,
      credentials: init.credentials,
    });
    const json = (b: unknown, status = 200) =>
      new Response(JSON.stringify(b), {
        status,
        headers: { "content-type": "application/json" },
      });
    switch (url.pathname) {
      case "/acme/.well-known/polaris.json":
        return json(disc);
      case "/acme/.well-known/polaris-trust.jws":
        return new Response("", { status: 404 });
      case "/acme/license/activate":
        return headers.authorization === "Bearer pkey_good"
          ? json({ token: "pkeyt_one", schemaVersion: 1 })
          : json(
              { error: { code: "device_limit", limit: 2, deviceCount: 2 } },
              403,
            );
      case "/acme/devices/register":
        return json({ token: "pkeyt_reg", deviceId: DEVICE });
      case "/acme/license/document":
        return licenseStatus === 200
          ? new Response(license, { status: 200, headers: { etag: '"L1"' } })
          : json({ error: { code: "unauthorized" } }, licenseStatus);
      case "/acme/config/document":
        return new Response(config, { status: 200, headers: { etag: '"C1"' } });
      case "/acme/devices/report":
        return json({ ok: true });
      case "/acme/devices":
        return json({
          devices: [
            {
              id: DEVICE,
              status: "active",
              current: true,
              label: "This browser",
            },
            {
              id: "other",
              status: "active",
              current: false,
              platform: "macos",
            },
          ],
        });
      case "/acme/license/deauthorize":
        return json({ ok: true });
      case "/acme/license/token":
        return json({ error: "unauthorized" }, 401);
      default:
        return new Response("not found", { status: 404 });
    }
  }) as typeof fetch;
  return {
    key,
    seen,
    fetchImpl,
    revoke: () => {
      licenseStatus = 401;
    },
  };
}

async function seededFactory(): Promise<IDBFactory> {
  const factory = new IDBFactory();
  await indexedDbOfflineStore(factory)!.write("acme", { deviceId: DEVICE });
  return factory;
}

describe("auth: which transport a page uses", () => {
  it("resolves auto to bearer on another origin and cookie on the Worker's own", () => {
    expect(resolveAuthMode("auto", BASE, "https://play.acme.example")).toBe(
      "bearer",
    );
    expect(resolveAuthMode("auto", BASE, BASE)).toBe("cookie");
    expect(resolveAuthMode("bearer", BASE, BASE)).toBe("bearer");
    expect(resolveAuthMode("cookie", BASE, "https://play.acme.example")).toBe(
      "cookie",
    );
  });

  it("defaults to auto (owner decision Q1): first-party is cookie, cross-origin is bearer", () => {
    expect(resolveAuthMode(undefined, BASE, BASE)).toBe("cookie");
    expect(resolveAuthMode(undefined, BASE, "https://play.acme.example")).toBe(
      "bearer",
    );
    // An opaque origin (a sandboxed frame, a file: page) is never the Worker's own.
    expect(resolveAuthMode(undefined, BASE, "null")).toBe("bearer");
    // No page at all (a server render, this Node environment): cookie, and nothing loads.
    expect(resolveAuthMode(undefined, BASE)).toBe("cookie");
  });

  it("a Tauri page is bearer, by its origin or by Tauri's globals", () => {
    expect(resolveAuthMode(undefined, BASE, "tauri://localhost")).toBe(
      "bearer",
    );
    expect(resolveAuthMode(undefined, BASE, "http://tauri.localhost")).toBe(
      "bearer",
    );
    const g = globalThis as Record<string, unknown>;
    for (const name of ["__TAURI_INTERNALS__", "__TAURI__"]) {
      g[name] = {};
      try {
        // Even a page that claims the Worker's own origin is not first-party inside Tauri.
        expect(resolveAuthMode(undefined, BASE, BASE)).toBe("bearer");
      } finally {
        delete g[name];
      }
    }
    expect(resolveAuthMode(undefined, BASE, BASE)).toBe("cookie");
  });

  it("auto resolving to bearer without pinned keys never throws: it reports invalid-options in state and makes no request", async () => {
    const calls: string[] = [];
    const adapter = browserAdapter({
      productSlug: "acme",
      pageOrigin: "https://play.acme.example",
      offlineStore: null,
      fetchImpl: (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response("{}", { status: 500 });
      }) as typeof fetch,
    });
    expect(adapter.mode).toBe("browser");
    await settled(adapter);
    const s = adapter.snapshot();
    expect(s.error.identity?.code).toBe("invalid-options");
    expect(s.error.identity?.message).toMatch(/trust\.pinnedKeys/);
    expect(calls).toEqual([]);
    await expect(adapter.submitKey("KEY")).rejects.toMatchObject({
      code: "invalid-options",
    });
    await expect((adapter as BrowserAdapter).register()).rejects.toMatchObject({
      code: "invalid-options",
    });
    expect(calls).toEqual([]);
  });

  it("refuses bearer mode without pinned keys: nothing verifies otherwise", () => {
    expect(() =>
      browserAdapter({
        productSlug: "acme",
        auth: "bearer",
        offlineStore: null,
        autoStart: false,
      }),
    ).toThrow(/trust\.pinnedKeys/);
  });

  it("a cookie page answers the bearer-only features runtime-unsupported, and refuses them typed", async () => {
    const adapter = browserAdapter({
      auth: "cookie",
      productSlug: "acme",
      offlineStore: null,
      autoStart: false,
    });
    for (const f of [Feature.devicesManage, Feature.configMint])
      expect(adapter.supports(f)).toMatchObject({
        supported: false,
        reason: "runtime",
      });
    // Planned on the web (SP-R10), whatever the transport.
    expect(adapter.supports(Feature.commerceReceipt)).toMatchObject({
      supported: false,
    });
    expect(adapter.caps()).not.toContain(Feature.devicesManage);
    await expect(adapter.listDevices()).rejects.toMatchObject({
      code: "device-management-unsupported",
      reason: "runtime",
    });
    await expect(adapter.mintToken("x")).rejects.toMatchObject({
      code: "unsupported",
    });
    expect(await adapter.storeStatus()).toBeNull();
  });
});

describe("bearer mode: activate, sync, devices, reload", () => {
  it("activates over the CORS routes, verifies both documents in-page, and never sends a cookie", async () => {
    const s = await server();
    const factory = await seededFactory();
    const adapter = browserAdapter({
      productSlug: "acme",
      auth: "bearer",
      trust: { pinnedKeys: { [s.key.kid]: s.key.raw } },
      fetchImpl: s.fetchImpl,
      now: () => NOW,
      version: "1.2.0",
      store: indexedDbStore("acme", {
        factory,
        persistence: { persisted: async () => true },
      })!,
    });
    await settled(adapter);
    expect(adapter.snapshot().status).toBe("needs-activation");
    // `requires-license`: no keyless registration was attempted.
    expect(s.seen.some((r) => r.path.endsWith("/devices/register"))).toBe(
      false,
    );

    const err = await adapter.submitKey("pkey_bad").catch((e: unknown) => e);
    expect(err).toMatchObject({
      activation: { kind: "deviceLimit", limit: 2, deviceCount: 2 },
    });

    await adapter.submitKey("pkey_good");
    const snap = adapter.snapshot();
    expect(snap.status).toBe("ok");
    expect(snap.activation).toBe("token");
    expect(adapter.isEntitled("pro")).toBe(true);
    expect(adapter.getConfig("ui.theme", "light")).toBe("dark");
    expect(snap.profile?.name).toBe("Ada");

    const doc = s.seen.find((r) => r.path === "/acme/license/document")!;
    expect(doc.headers.authorization).toBe("Bearer pkeyt_one");
    expect(doc.headers["x-pkey-device"]).toBe(DEVICE);
    expect(doc.headers["x-pkey-platform"]).toBe("web");
    expect(doc.headers["x-pkey-arch"]).toBe("wasm32");
    expect(doc.headers["x-pkey-sdk"]).toBe("react");
    expect(
      s.seen.every(
        (r) => r.credentials === "omit" || r.credentials === undefined,
      ),
    ).toBe(true);
    // The sync reported, with the browser's facts.
    expect(s.seen.some((r) => r.path === "/acme/devices/report")).toBe(true);
    expect(adapter.supports(Feature.devicesManage)).toEqual({
      supported: true,
      feature: Feature.devicesManage,
    });

    const devices = await adapter.listDevices();
    expect(devices.map((d) => [d.id, d.current])).toEqual([
      [DEVICE, true],
      ["other", false],
    ]);
    expect(await adapter.storeStatus()).toEqual({ backend: "indexeddb" });
    expect(await adapter.offlineDeviceId()).toBe(DEVICE);
    adapter.dispose();

    // A reload with the network down: the token and the cache come back, re-verified.
    const offline = browserAdapter({
      productSlug: "acme",
      auth: "bearer",
      trust: { pinnedKeys: { [s.key.kid]: s.key.raw } },
      fetchImpl: (async () => {
        throw new TypeError("Failed to fetch");
      }) as typeof fetch,
      now: () => NOW + 60,
      store: indexedDbStore("acme", { factory })!,
    });
    await settled(offline);
    expect(offline.snapshot().status).toBe("ok");
    expect(offline.isEntitled("pro")).toBe(true);
    expect((await offline.storeStatus())?.degraded?.reason).toBe(
      "not-persistent",
    );

    // A cache signed by another key is not a source: the same record under other pins is empty.
    const other = await newTestKey("pkey-test-other");
    const forged = browserAdapter({
      productSlug: "acme",
      auth: "bearer",
      trust: { pinnedKeys: { [other.kid]: other.raw } },
      fetchImpl: (async () => {
        throw new TypeError("Failed to fetch");
      }) as typeof fetch,
      now: () => NOW + 60,
      store: indexedDbStore("acme", { factory })!,
    });
    await settled(forged);
    expect(forged.snapshot().status).not.toBe("ok");
    expect(forged.isEntitled("pro")).toBe(false);
  });

  it("a revoked licence keeps its last grants but unlocks nothing (S-19 G11)", async () => {
    const s = await server();
    const adapter = browserAdapter({
      productSlug: "acme",
      auth: "bearer",
      trust: { pinnedKeys: { [s.key.kid]: s.key.raw } },
      fetchImpl: s.fetchImpl,
      now: () => NOW,
      store: indexedDbStore("acme", { factory: await seededFactory() })!,
    });
    await settled(adapter);
    await adapter.submitKey("pkey_good");
    expect(adapter.isEntitled("pro")).toBe(true);
    s.revoke();
    await adapter.refresh();
    expect(adapter.snapshot().status).toBe("revoked");
    expect(adapter.snapshot().entitlements.pro).toBe(true);
    expect(adapter.isEntitled("pro")).toBe(false);
  });

  it("registers keylessly at load when discovery says registration is open", async () => {
    const s = await server({ registration: "open" });
    const adapter = browserAdapter({
      productSlug: "acme",
      auth: "bearer",
      trust: { pinnedKeys: { [s.key.kid]: s.key.raw } },
      fetchImpl: s.fetchImpl,
      now: () => NOW,
      store: indexedDbStore("acme", { factory: await seededFactory() })!,
    });
    await settled(adapter);
    const reg = s.seen.find((r) => r.path === "/acme/devices/register")!;
    expect(reg.headers.authorization).toBeUndefined();
    expect(adapter.snapshot().activation).toBe("token");
  });

  it("signs out: deauthorizes, wipes the token and every grant", async () => {
    const s = await server();
    const factory = await seededFactory();
    const adapter = browserAdapter({
      productSlug: "acme",
      auth: "bearer",
      trust: { pinnedKeys: { [s.key.kid]: s.key.raw } },
      fetchImpl: s.fetchImpl,
      now: () => NOW,
      store: indexedDbStore("acme", { factory })!,
    });
    await settled(adapter);
    await adapter.submitKey("pkey_good");
    await adapter.signOut();
    expect(s.seen.some((r) => r.path === "/acme/license/deauthorize")).toBe(
      true,
    );
    expect(adapter.snapshot().status).toBe("needs-activation");
    expect(await indexedDbStore("acme", { factory })!.getToken()).toBeNull();
  });
});

describe("browser facts", () => {
  it("reports only what the page states about itself", () => {
    expect(
      browserFacts({
        navigator: {
          userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)",
          language: "fr-FR",
          hardwareConcurrency: 8,
          deviceMemory: 8,
        },
        timeZone: "Europe/Paris",
      }),
    ).toEqual({
      os: { name: "macos" },
      hardware: { cpuCores: 8, ramMb: 8192 },
      runtime: { name: "browser", version: "web" },
      locale: "fr-FR",
      timezone: "Europe/Paris",
    });
    expect(browserFacts({})).toEqual({
      os: { name: "unknown" },
      runtime: { name: "browser", version: "web" },
    });
  });
});
