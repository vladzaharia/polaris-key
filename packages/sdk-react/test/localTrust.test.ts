// @vitest-environment node
//
// @pkey-feature core.sync core.cache core.verify license.gate
//
// The client-local trust rules in the React SDK. A hard 401 / a 403 build block deletes the
// slice (document + ETag) in the same cache write that sets the hint, so clearing the hint
// hands back nothing. Unsigned discovery turns the licence gate on, never off. Network
// verification runs at the effective clock. Device binding is a typed N/A in a browser
// (declared in parity.json): there is no hardware anchor.

import { describe, expect, it } from "vitest";
import type { CacheRecordV3, Store } from "@polaris-key/client-core";
import { BearerSession } from "../src/browser/bearer/session.js";
import { browserAdapter } from "../src/browser/browserAdapter.js";
import {
  makeDoc,
  makeFakeFetch,
  newTestKey,
  services,
  signCompact,
} from "./fixtures.js";

const NOW = 1_700_000_000;
const DEVICE = "LOCALTRUSTDEV000000000000000001";

class MemStore implements Store {
  cache: CacheRecordV3 | null = null;
  token: string | null = "pkeyt_test";
  async getToken() {
    return this.token;
  }
  async setToken(t: string) {
    this.token = t;
  }
  async clearToken() {
    this.token = null;
  }
  async getDeviceId() {
    return DEVICE;
  }
  async readCache() {
    return this.cache;
  }
  async writeCache(rec: CacheRecordV3) {
    this.cache = structuredClone(rec);
  }
  async clearCache() {
    this.cache = null;
  }
}

async function harness(opts: { clock?: { t: number } } = {}) {
  const key = await newTestKey("pkey-local-trust");
  const clock = opts.clock ?? { t: NOW };
  const store = new MemStore();
  let mode: "ok" | "401" | "403" = "ok";
  let issuedAt = NOW - 10;
  const sign = (typ: "pkey-license+jws" | "pkey-config+jws") =>
    signCompact(
      {
        iss: "key.plrs.im",
        aud: "acme",
        deviceId: DEVICE,
        issuedAt,
        expiresAt: issuedAt + 3600,
        graceUntil: issuedAt + 86400,
        ...(typ === "pkey-license+jws"
          ? { licenseId: "lic-1", entitlements: {} }
          : { schemaVersion: 1, secrets: {}, config: {} }),
      },
      key,
      typ,
    );
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    if (
      path.endsWith("/license/document") ||
      path.endsWith("/config/document")
    ) {
      if (mode === "401") return new Response("", { status: 401 });
      if (mode === "403")
        return new Response(
          JSON.stringify({
            error: { code: "version_blocked", reason: "version-too-old" },
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      const lic = path.endsWith("/license/document");
      return new Response(
        await sign(lic ? "pkey-license+jws" : "pkey-config+jws"),
        {
          status: 200,
          headers: { etag: lic ? '"L1"' : '"C1"' },
        },
      );
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  const make = () =>
    new BearerSession({
      baseUrl: "https://key.plrs.im",
      product: "acme",
      version: "1.0.0",
      fetchImpl,
      now: () => clock.t,
      pinned: { [key.kid]: key.raw },
      store,
      enabled: (slug) => slug === "license" || slug === "config",
      random: () => 0,
    });
  return {
    store,
    make,
    clock,
    set: (m: typeof mode) => (mode = m),
    issueAt: (n: number) => (issuedAt = n),
  };
}

describe("a hard refusal deletes the slice it answered for", () => {
  it("401 on the licence removes document + ETag in the same write as the hint; a reload holds nothing", async () => {
    const h = await harness();
    const s = h.make();
    await s.sync();
    expect(s.documents.license).not.toBeNull();
    expect(h.store.cache?.docs?.license).toBeTruthy();
    h.set("401");
    await s.sync({ force: true });
    expect(s.documents.license).toBeNull();
    expect(s.documents.config).toBeNull();
    expect(h.store.cache?.lastSyncUnauthorized).toBe(true);
    expect(h.store.cache?.docs?.license).toBeUndefined();
    expect(h.store.cache?.docs?.config).toBeUndefined();
    expect(h.store.cache?.etags?.license).toBeUndefined();
    expect(h.store.cache?.etags?.config).toBeUndefined();
    expect(h.store.token).toBe("pkeyt_test");
    // Clearing the (display-only) hint, as an attacker with the plain-JSON record could, hands
    // back nothing to verify.
    h.store.cache = { ...h.store.cache!, lastSyncUnauthorized: false };
    const reload = h.make();
    await reload.init();
    expect(reload.documents.license).toBeNull();
    expect(reload.syncState().doc).toBeNull();
  });

  it("a 403 build block removes the licence document and ETag with `blocked`", async () => {
    const h = await harness();
    const s = h.make();
    await s.sync();
    h.set("403");
    await s.sync({ force: true });
    expect(s.documents.license).toBeNull();
    expect(h.store.cache?.blocked).toBeTruthy();
    expect(h.store.cache?.docs?.license).toBeUndefined();
    expect(h.store.cache?.etags?.license).toBeUndefined();
    expect(h.store.token).toBe("pkeyt_test");
    const { blocked: _b, ...rest } = h.store.cache!;
    h.store.cache = rest;
    const reload = h.make();
    await reload.init();
    expect(reload.documents.license).toBeNull();
  });
});

describe("network verification runs at the effective clock", () => {
  it("accepts a re-signed document when the system clock was wound back below the floor", async () => {
    const h = await harness();
    const s = h.make();
    await s.sync();
    expect(s.documents.license).not.toBeNull();
    // The clock is rewound far behind the floor; the server re-signs a newer document.
    h.clock.t = NOW - 1_000_000;
    h.issueAt(NOW + 1);
    await s.sync({ force: true });
    expect(s.documents.license?.issuedAt).toBe(NOW + 1);
  });
});

describe("unsigned discovery turns the gate on, never off", () => {
  const disabled = () =>
    makeFakeFetch(null, { capabilities: services("config") });

  it("a build expecting the default services stays gated when discovery says licence is off", async () => {
    const a = browserAdapter({
      auth: "cookie",
      productSlug: "acme",
      fetchImpl: disabled(),
      now: () => NOW,
    });
    for (let i = 0; i < 100 && a.snapshot().phase === "loading"; i += 1)
      await new Promise((r) => setTimeout(r, 2));
    expect(a.snapshot().capabilities.license.enabled).toBe(false);
    expect(a.snapshot().status).toBe("needs-activation");
    a.dispose();
  });

  it("a config-only build (expectServices without licence) is not gated", async () => {
    const a = browserAdapter({
      auth: "cookie",
      productSlug: "acme",
      expectServices: services("config"),
      fetchImpl: disabled(),
      now: () => NOW,
    });
    for (let i = 0; i < 100 && a.snapshot().phase === "loading"; i += 1)
      await new Promise((r) => setTimeout(r, 2));
    expect(a.snapshot().status).toBe("not-applicable");
    a.dispose();
  });

  it("discovery switching the licence on gates a config-only build", async () => {
    const a = browserAdapter({
      auth: "cookie",
      productSlug: "acme",
      expectServices: services("config"),
      fetchImpl: makeFakeFetch(null, {
        capabilities: services("license", "config"),
      }),
      now: () => NOW,
    });
    for (let i = 0; i < 100 && a.snapshot().phase === "loading"; i += 1)
      await new Promise((r) => setTimeout(r, 2));
    expect(a.snapshot().status).toBe("needs-activation");
    a.dispose();
  });
});

void makeDoc;

describe("the licence gate on the desktop bridge", () => {
  it("a host reporting the licence off does not ungate a build that expects it", async () => {
    const { desktopAdapter } = await import("../src/desktop/desktopAdapter.js");
    const { makeFakeBridge, okBridgeState } = await import("./fixtures.js");
    const bridge = makeFakeBridge(
      okBridgeState({ doc: null, capabilities: services("config") }),
    );
    const a = desktopAdapter({ bridge, now: () => 2000 });
    for (let i = 0; i < 50 && a.snapshot().phase === "loading"; i += 1)
      await new Promise((r) => setTimeout(r, 0));
    expect(a.snapshot().status).not.toBe("not-applicable");
    a.dispose();
  });
});
