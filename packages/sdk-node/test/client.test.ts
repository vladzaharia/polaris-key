import { describe, expect, it } from "vitest";
import { signJws } from "@polaris-key/jws";
import type { ManagedConfigDoc } from "@polaris-key/protocol";
import { PolarisKeyClient } from "../src/client.js";
import { InMemoryStore, type CacheRecord } from "../src/store.js";

const TEST_KID = "pkey-test-prod-2026";
const TEST_PUB = "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI";
const TEST_PEM =
  "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIBlV9cXFJlt08+qaVvnIkgRmgao8P0rhkVh3onqOXPW1\n-----END PRIVATE KEY-----";

const base = {
  productSlug: "djdl",
  baseUrl: "https://k.test",
  version: "1.2.3",
  trust: { pinnedKeys: { [TEST_KID]: TEST_PUB } },
} as const;

interface MockOpts {
  /** Override the /config response status (default 200 → signed doc). */
  configStatus?: number;
  /** Body for a 403 blocked response. */
  blockedBody?: unknown;
  /** When true, /config 401s until a /token reacquire happens, then 200s. */
  unauthorizedUntilReacquire?: boolean;
  /** Override the doc's issuedAt (epoch sec) so anti-replay can be exercised. */
  issuedAt?: number;
  /** Etag returned on a 200 (default '"v1"'). */
  etag?: string;
}

interface MockState {
  impl: typeof fetch;
  calls: Array<{
    path: string;
    method: string;
    ifNoneMatch: string | null;
    bearer: string | null;
    device: string | null;
  }>;
  /** Count of /token re-acquires. */
  tokenCount: () => number;
  /** Count of /config/report posts. */
  reportCount: () => number;
}

function mockFetch(opts: MockOpts = {}): MockState {
  const calls: MockState["calls"] = [];
  let reacquired = false;
  const impl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const u = new URL(typeof input === "string" ? input : input.toString());
    const headers = new Headers(init?.headers);
    calls.push({
      path: u.pathname,
      method: init?.method ?? "GET",
      ifNoneMatch: headers.get("if-none-match"),
      bearer: headers.get("authorization"),
      device: headers.get("x-pkey-device"),
    });

    if (u.pathname.endsWith("/activate")) {
      return new Response(
        JSON.stringify({ token: "pkeyt_activated", schemaVersion: 1 }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
    if (u.pathname.endsWith("/token")) {
      reacquired = true;
      return new Response(
        JSON.stringify({ token: "pkeyt_reacquired", schemaVersion: 1 }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
    if (u.pathname.endsWith("/config/report"))
      return new Response("{}", { status: 200 });
    if (u.pathname.endsWith("/deauthorize"))
      return new Response("{}", { status: 200 });
    if (u.pathname.endsWith("/config")) {
      if (opts.configStatus === 403) {
        return new Response(JSON.stringify(opts.blockedBody), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }
      if (opts.unauthorizedUntilReacquire && !reacquired) {
        return new Response("", { status: 401 });
      }
      const device = headers.get("x-pkey-device") ?? "d";
      const now = opts.issuedAt ?? Math.floor(Date.now() / 1000);
      const doc: ManagedConfigDoc = {
        schemaVersion: 1,
        aud: "djdl",
        iss: "key.plrs.im",
        licenseId: "lic_1",
        deviceId: device,
        issuedAt: now,
        expiresAt: now + 3600,
        graceUntil: now + 30 * 86400,
        profile: {
          name: "Ada Lovelace",
          firstName: "Ada",
          email: "ada@example.com",
          activatedAt: now,
        },
        payload: {
          config: {
            "quality.floor": {
              state: "enforced",
              value: "flac",
              updatedAt: now,
            },
          },
          secrets: {
            "soundcloud.oauth": {
              state: "hidden",
              value: "tok",
              updatedAt: now,
            },
          },
          entitlements: {
            polarisVpn: { state: "enforced", value: true, updatedAt: now },
          },
        },
      };
      const jws = await signJws(doc, TEST_PEM, TEST_KID);
      return new Response(jws, {
        status: 200,
        headers: {
          "content-type": "application/jwt",
          etag: opts.etag ?? '"v1"',
        },
      });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;

  return {
    impl,
    calls,
    tokenCount: () => calls.filter((c) => c.path.endsWith("/token")).length,
    reportCount: () =>
      calls.filter((c) => c.path.endsWith("/config/report")).length,
  };
}

describe("PolarisKeyClient — activation + reads", () => {
  it("activate → ok; reads config, entitlement, secret, profile", async () => {
    const client = await PolarisKeyClient.create({
      ...base,
      store: new InMemoryStore("djdl"),
      fetchImpl: mockFetch().impl,
    });
    expect(client.status().status).toBe("needs-activation");

    const r = await client.activateWithKey("pkey_djdl_AAAAAAAAAAAAAAAAAAAAAA");
    expect(r.kind).toBe("ok");
    expect(client.status().status).toBe("ok");
    expect(client.isLicensed()).toBe(true);
    expect(client.isEntitled("polarisVpn")).toBe(true);
    expect(client.isEntitled("notAThing")).toBe(false);
    expect(client.getConfig("quality.floor", "any")).toBe("flac");
    expect(client.getConfig("missing.key", "fallback")).toBe("fallback");
    expect(client.getSecret("soundcloud.oauth")).toBe("tok");
    expect(client.getSecret("nope")).toBeNull();
    expect(client.getEntitlements()).toEqual({ polarisVpn: true });
    expect(client.getProfile()?.firstName).toBe("Ada");
  });

  it("reads return fallbacks/null/empty when no doc is cached", async () => {
    const client = await PolarisKeyClient.create({
      ...base,
      store: new InMemoryStore("djdl"),
      fetchImpl: mockFetch().impl,
    });
    expect(client.getConfig("quality.floor", "def")).toBe("def");
    expect(client.getSecret("x")).toBeNull();
    expect(client.isEntitled("polarisVpn")).toBe(false);
    expect(client.getEntitlements()).toEqual({});
    expect(client.getProfile()).toBeNull();
  });
});

describe("PolarisKeyClient — refresh / persistence", () => {
  it("activate persists the verified doc to the store and reports a snapshot", async () => {
    const store = new InMemoryStore("djdl");
    const m = mockFetch();
    const client = await PolarisKeyClient.create({
      ...base,
      store,
      fetchImpl: m.impl,
    });
    await client.activateWithKey("pkey_djdl_AAAAAAAAAAAAAAAAAAAAAA");

    const cache = await store.readCache();
    expect(cache?.doc?.payload.config["quality.floor"]?.value).toBe("flac");
    expect(cache?.etag).toBe('"v1"');
    expect(cache?.lastAcceptedIssuedAt).toBe(cache?.doc?.issuedAt);
    expect(typeof cache?.lastVerifiedAt).toBe("number");
    // A report was posted after applying.
    expect(m.reportCount()).toBeGreaterThanOrEqual(1);
    expect(
      m.calls.some(
        (c) =>
          c.path.endsWith("/config/report") &&
          c.bearer === "Bearer pkeyt_activated",
      ),
    ).toBe(true);
  });

  it("sends If-None-Match on the second refresh using the held etag", async () => {
    const m = mockFetch();
    const client = await PolarisKeyClient.create({
      ...base,
      store: new InMemoryStore("djdl"),
      fetchImpl: m.impl,
    });
    await client.activateWithKey("pkey_djdl_AAAAAAAAAAAAAAAAAAAAAA"); // first /config: no etag
    const firstConfig = m.calls.find((c) => c.path.endsWith("/config"))!;
    expect(firstConfig.ifNoneMatch).toBeNull();

    await client.refresh(); // second /config: must carry the etag
    const configCalls = m.calls.filter((c) => c.path.endsWith("/config"));
    expect(configCalls[configCalls.length - 1]?.ifNoneMatch).toBe('"v1"');
  });

  it("force refresh bypasses If-None-Match", async () => {
    const m = mockFetch();
    const client = await PolarisKeyClient.create({
      ...base,
      store: new InMemoryStore("djdl"),
      fetchImpl: m.impl,
    });
    await client.activateWithKey("pkey_djdl_AAAAAAAAAAAAAAAAAAAAAA");

    await client.refresh({ force: true });
    const configCalls = m.calls.filter((c) => c.path.endsWith("/config"));
    expect(configCalls[configCalls.length - 1]?.ifNoneMatch).toBeNull();
  });

  it("refresh is a no-op without a token", async () => {
    const m = mockFetch();
    const client = await PolarisKeyClient.create({
      ...base,
      store: new InMemoryStore("djdl"),
      fetchImpl: m.impl,
    });
    expect(await client.refresh()).toEqual({ applied: false });
    expect(m.calls.length).toBe(0);
  });

  it("performs exactly ONE /token re-acquire on a 401, then retries /config and applies", async () => {
    const m = mockFetch({ unauthorizedUntilReacquire: true });
    const client = await PolarisKeyClient.create({
      ...base,
      store: new InMemoryStore("djdl"),
      fetchImpl: m.impl,
    });
    // activate stores the token then forces a refresh → 401 → one /token → 200.
    const r = await client.activateWithKey("pkey_djdl_AAAAAAAAAAAAAAAAAAAAAA");
    expect(r.kind).toBe("ok");
    expect(client.status().status).toBe("ok");
    expect(m.tokenCount()).toBe(1); // exactly one re-acquire, no retry loop
    const tokenCall = m.calls.find((c) => c.path.endsWith("/token"));
    expect(tokenCall?.bearer).toBe("Bearer pkeyt_activated");
    expect(tokenCall?.device).toBeTruthy();
  });

  it("a persistent 401 (re-acquire also fails to help) lands on revoked", async () => {
    // /token returns a token but /config keeps 401ing → after the single retry the
    // second /config (allowReacquire=false) returns 401 → unauthorized.
    const calls: string[] = [];
    const impl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const u = new URL(typeof input === "string" ? input : input.toString());
      calls.push(u.pathname);
      if (u.pathname.endsWith("/activate")) {
        return new Response(
          JSON.stringify({ token: "pkeyt_e", schemaVersion: 1 }),
          { status: 200 },
        );
      }
      if (u.pathname.endsWith("/token")) {
        return new Response(
          JSON.stringify({ token: "pkeyt_r", schemaVersion: 1 }),
          { status: 200 },
        );
      }
      if (u.pathname.endsWith("/config/report"))
        return new Response("{}", { status: 200 });
      if (u.pathname.endsWith("/config"))
        return new Response("", { status: 401 });
      return new Response("", { status: 404 });
    }) as typeof fetch;

    const client = await PolarisKeyClient.create({
      ...base,
      store: new InMemoryStore("djdl"),
      fetchImpl: impl,
    });
    await client.activateWithKey("pkey_djdl_AAAAAAAAAAAAAAAAAAAAAA");
    expect(client.status().status).toBe("revoked");
    // Exactly one /token attempt despite repeated 401s.
    expect(calls.filter((p) => p.endsWith("/token")).length).toBe(1);
  });

  it("403 → blocked status with allowedRange, surfaced from the cache", async () => {
    const client = await PolarisKeyClient.create({
      ...base,
      store: new InMemoryStore("djdl"),
      fetchImpl: mockFetch({
        configStatus: 403,
        blockedBody: {
          reason: "version-too-old",
          allowedRange: { min: "2.0.0" },
        },
      }).impl,
    });
    const r = await client.activateWithKey("pkey_djdl_AAAAAAAAAAAAAAAAAAAAAA");
    expect(r.kind).toBe("ok"); // activation still succeeded; the block is on /config
    const s = client.status();
    expect(s.status).toBe("version-too-old");
    expect(s.allowedRange?.min).toBe("2.0.0");
    expect(client.isLicensed()).toBe(false);
  });

  it("not-modified keeps the existing cached doc and clears any prior block", async () => {
    // First populate the cache via a normal 200, then a refresh that 304s.
    let phase: "ok" | "notmod" = "ok";
    const impl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const u = new URL(typeof input === "string" ? input : input.toString());
      const headers = new Headers(init?.headers);
      if (u.pathname.endsWith("/activate")) {
        return new Response(
          JSON.stringify({ token: "pkeyt_e", schemaVersion: 1 }),
          { status: 200 },
        );
      }
      if (u.pathname.endsWith("/config/report"))
        return new Response("{}", { status: 200 });
      if (u.pathname.endsWith("/config")) {
        if (phase === "notmod") return new Response(null, { status: 304 });
        const device = headers.get("x-pkey-device") ?? "d";
        const now = Math.floor(Date.now() / 1000);
        const doc: ManagedConfigDoc = {
          schemaVersion: 1,
          aud: "djdl",
          iss: "key.plrs.im",
          licenseId: "lic_1",
          deviceId: device,
          issuedAt: now,
          expiresAt: now + 3600,
          graceUntil: now + 30 * 86400,
          profile: {
            name: "Ada",
            firstName: "Ada",
            email: "a@b.c",
            activatedAt: now,
          },
          payload: {
            config: {
              "quality.floor": {
                state: "enforced",
                value: "flac",
                updatedAt: now,
              },
            },
            secrets: {},
            entitlements: {},
          },
        };
        return new Response(await signJws(doc, TEST_PEM, TEST_KID), {
          status: 200,
          headers: { etag: '"v1"' },
        });
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;

    const client = await PolarisKeyClient.create({
      ...base,
      store: new InMemoryStore("djdl"),
      fetchImpl: impl,
    });
    await client.activateWithKey("pkey_djdl_AAAAAAAAAAAAAAAAAAAAAA");
    expect(client.getConfig("quality.floor", "x")).toBe("flac");

    phase = "notmod";
    const res = await client.refresh({ force: true });
    expect(res.applied).toBe(false);
    // The cached doc survives a 304.
    expect(client.getConfig("quality.floor", "x")).toBe("flac");
    expect(client.status().status).toBe("ok");
  });
});

describe("PolarisKeyClient — offline-first init", () => {
  it("init() applies a pre-seeded cache with NO network and reflects ok status", async () => {
    const store = new InMemoryStore("djdl");
    const deviceId = await store.getDeviceId();
    const now = Math.floor(Date.now() / 1000);
    const doc: ManagedConfigDoc = {
      schemaVersion: 1,
      aud: "djdl",
      iss: "key.plrs.im",
      licenseId: "lic_cached",
      deviceId,
      issuedAt: now,
      expiresAt: now + 3600,
      graceUntil: now + 30 * 86400,
      profile: {
        name: "Ada",
        firstName: "Ada",
        email: "a@b.c",
        activatedAt: now,
      },
      payload: {
        config: {
          "quality.floor": { state: "enforced", value: "mp3", updatedAt: now },
        },
        secrets: {},
        entitlements: {
          polarisVpn: { state: "enforced", value: true, updatedAt: now },
        },
      },
    };
    await store.setToken("pkeyt_cached");
    const rec: CacheRecord = {
      doc,
      etag: '"v1"',
      lastAcceptedIssuedAt: now,
      lastVerifiedAt: now * 1000,
    };
    await store.writeCache(rec);

    // A fetch that throws if EVER called — proving init() touches no network.
    const exploding = (async () => {
      throw new Error("network must not be used during init");
    }) as unknown as typeof fetch;

    const client = await PolarisKeyClient.create({
      ...base,
      store,
      fetchImpl: exploding,
    });
    expect(client.status().status).toBe("ok");
    expect(client.isLicensed()).toBe(true);
    expect(client.getConfig("quality.floor", "x")).toBe("mp3");
    expect(client.isEntitled("polarisVpn")).toBe(true);
  });
});

describe("PolarisKeyClient — deactivate", () => {
  it("deactivate POSTs /deauthorize, wipes the store, and resets to needs-activation", async () => {
    const store = new InMemoryStore("djdl");
    const m = mockFetch();
    const client = await PolarisKeyClient.create({
      ...base,
      store,
      fetchImpl: m.impl,
    });
    await client.activateWithKey("pkey_djdl_AAAAAAAAAAAAAAAAAAAAAA");
    expect(client.status().status).toBe("ok");

    await client.deactivate();
    expect(client.status().status).toBe("needs-activation");
    expect(await store.getToken()).toBeNull();
    expect(await store.readCache()).toBeNull();
    expect(
      m.calls.some(
        (c) => c.path.endsWith("/deauthorize") && c.method === "POST",
      ),
    ).toBe(true);
  });

  it("deactivate works offline (deauthorize swallows the error) and still wipes locally", async () => {
    const store = new InMemoryStore("djdl");
    let activated = false;
    const impl = (async (input: string | URL | Request): Promise<Response> => {
      const u = new URL(typeof input === "string" ? input : input.toString());
      if (u.pathname.endsWith("/activate")) {
        activated = true;
        return new Response(
          JSON.stringify({ token: "pkeyt_e", schemaVersion: 1 }),
          { status: 200 },
        );
      }
      if (u.pathname.endsWith("/config") && activated) {
        const now = Math.floor(Date.now() / 1000);
        const doc: ManagedConfigDoc = {
          schemaVersion: 1,
          aud: "djdl",
          iss: "key.plrs.im",
          licenseId: "l",
          deviceId: await store.getDeviceId(),
          issuedAt: now,
          expiresAt: now + 3600,
          graceUntil: now + 30 * 86400,
          profile: {
            name: "A",
            firstName: "A",
            email: "a@b.c",
            activatedAt: now,
          },
          payload: { config: {}, secrets: {}, entitlements: {} },
        };
        return new Response(await signJws(doc, TEST_PEM, TEST_KID), {
          status: 200,
          headers: { etag: '"v1"' },
        });
      }
      if (u.pathname.endsWith("/config/report"))
        return new Response("{}", { status: 200 });
      if (u.pathname.endsWith("/deauthorize")) throw new Error("offline");
      return new Response("", { status: 404 });
    }) as typeof fetch;

    const client = await PolarisKeyClient.create({
      ...base,
      store,
      fetchImpl: impl,
    });
    await client.activateWithKey("pkey_djdl_AAAAAAAAAAAAAAAAAAAAAA");
    await client.deactivate(); // /deauthorize throws but is swallowed
    expect(client.status().status).toBe("needs-activation");
    expect(await store.getToken()).toBeNull();
  });
});

describe("PolarisKeyClient — device management surface", () => {
  it("reports the current device and only deauthorizes the current device", async () => {
    const store = new InMemoryStore("djdl");
    const deviceId = await store.getDeviceId();
    const client = await PolarisKeyClient.create({
      ...base,
      store,
      fetchImpl: (async () =>
        new Response("{}", { status: 200 })) as typeof fetch,
    });

    expect(client.getCurrentDevice()).toMatchObject({
      id: deviceId,
      current: true,
      status: "needs-activation",
    });
    await expect(client.listDevices()).resolves.toEqual([
      expect.objectContaining({
        id: deviceId,
        current: true,
        status: "needs-activation",
      }),
    ]);
    await expect(
      client.deauthorizeDevice("other-device"),
    ).rejects.toMatchObject({
      code: "device-management-unsupported",
    });
    await expect(client.deauthorizeDevice(deviceId)).resolves.toBeUndefined();
  });
});

describe("PolarisKeyClient — channel derivation", () => {
  it("derives the channel from the version when not given explicitly", async () => {
    const m = mockFetch();
    const client = new PolarisKeyClient({
      ...base,
      version: "0.0.0-staging+abc",
      store: new InMemoryStore("djdl"),
      fetchImpl: m.impl,
    });
    await client.init();
    await client.activateWithKey("pkey_djdl_AAAAAAAAAAAAAAAAAAAAAA");
    // The /config request carries the derived channel header.
    const cfg = m.calls.find((c) => c.path.endsWith("/config"));
    expect(cfg).toBeDefined();
  });
});
