// `PolarisKeyClient` behaviour pins — the suite facade over Core + the per-service sub-clients.
//
// These are the descendants of the pre-suite `PolarisKeyClient` tests, re-attributed to the
// modules that own each behaviour now. Nothing was dropped: activation, the reads, cache
// persistence, the conditional-request rules, the single 401 re-acquire, the 403 build gate,
// offline-first init, deactivation, the device surface and channel derivation all still have a
// pin here. What CHANGED is the shape they are expressed in, and every change is a wire
// contract v3 rule:
//
//   * ONE document became TWO (§2.1/§2.2). Entitlements + profile ride `pkey-license+jws`;
//     config + secrets ride `pkey-config+jws`. They are fetched IN PARALLEL from two routes
//     with two independent ETags, so every fixture below answers both.
//   * `refresh()` became `sync()` (§5) and returns a per-document outcome map.
//   * The cache record is v3 (§4.1): `docs`/`etags` per slice, signed artifacts only. The
//     decoded doc and the unsigned counters that used to sit beside it are GONE, and the
//     "no such property" assertions below are what keeps them gone (R4-01/R4-03/R4-04).
//   * `iss` is `key.plrs.im`, tokens are `pkeyt_`, headers are `X-PKey-*` (§8).
//
// `trustRefresh` is off in the shared base: Core's trust cadence is a `sync()` concern with its
// own pins in sync.test.ts, and leaving it on here would put an unrelated request in the middle
// of every call-count assertion.

import { describe, expect, it } from "vitest";
import { signJws } from "@polaris-key/jws";
import { ISSUER } from "@polaris-key/protocol/core";
import type { ConfigDoc } from "@polaris-key/protocol/config";
import type { LicenseDoc } from "@polaris-key/protocol/license";
import type { CacheRecordV3 } from "@polaris-key/client-core";
import { PolarisKeyClient } from "../src/client.js";
import { CACHE_VERSION, InMemoryStore } from "../src/core/store.js";

const TEST_KID = "pkey-test-prod-2026";
const TEST_PUB = "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI";
const TEST_PEM =
  "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIBlV9cXFJlt08+qaVvnIkgRmgao8P0rhkVh3onqOXPW1\n-----END PRIVATE KEY-----";

const PRODUCT = "djdl";
const KEY = "pkey_djdl_AAAAAAAAAAAAAAAAAAAAAA";
const nowSec = (): number => Math.floor(Date.now() / 1000);

const base = {
  productSlug: PRODUCT,
  baseUrl: "https://k.test",
  version: "1.2.3",
  trust: { pinnedKeys: { [TEST_KID]: TEST_PUB } },
  // Core's trust cadence has its own pins in sync.test.ts; keeping it out of these fixtures
  // keeps the fetch-call assertions about the DOCUMENTS.
  trustRefresh: false,
  // Hardware probes shell out (ioreg/sw_vers); nothing here asserts on a fingerprint.
  license: { fingerprint: false },
  devices: { fingerprint: false },
  // Resolution layers are the config service's, and an ambient `PKEY_CONFIG_*` var in the
  // developer's shell must not be able to change what these tests observe.
  config: { env: {} },
} as const;

// ── Fixtures: the two v3 documents ────────────────────────────────────────────────────────

function licenseDoc(deviceId: string, at: number): LicenseDoc {
  return {
    iss: ISSUER,
    aud: PRODUCT,
    deviceId,
    issuedAt: at,
    expiresAt: at + 3600,
    graceUntil: at + 30 * 86400,
    licenseId: "lic_1",
    profile: {
      name: "Ada Lovelace",
      firstName: "Ada",
      email: "ada@example.com",
      activatedAt: at,
    },
    // §2.1 — `entitlements` is the ONLY carrier of grant data, and it lives here, not on the
    // config document.
    entitlements: {
      polarisVpn: { state: "enforced", value: true, updatedAt: at },
    },
  };
}

function configDoc(deviceId: string, at: number): ConfigDoc {
  return {
    iss: ISSUER,
    aud: PRODUCT,
    deviceId,
    issuedAt: at,
    expiresAt: at + 3600,
    graceUntil: at + 30 * 86400,
    schemaVersion: 4,
    config: {
      "quality.floor": { state: "enforced", value: "flac", updatedAt: at },
    },
    secrets: {
      "soundcloud.oauth": { state: "hidden", value: "tok", updatedAt: at },
    },
  };
}

// ── The mock control plane ────────────────────────────────────────────────────────────────

interface Call {
  path: string;
  method: string;
  ifNoneMatch: string | null;
  bearer: string | null;
  device: string | null;
  version: string | null;
  channel: string | null;
}

/** Mutable so a test can change what the control plane answers mid-scenario. */
interface MockOpts {
  /** 403 on `GET /license/document` — the build gate's route (D-20). */
  licenseBlocked?: boolean;
  /** Body served with that 403. */
  blockedBody?: unknown;
  /** Which documents 401 until one `POST /license/token` has landed. */
  unauthorizedUntilReacquire?: "license" | "both";
  /** Both documents 401 forever — a genuinely revoked credential. */
  alwaysUnauthorized?: boolean;
  /** Both documents answer 304 regardless of the validator sent. */
  notModified?: boolean;
}

interface MockState {
  impl: typeof fetch;
  calls: Call[];
  opts: MockOpts;
  count: (suffix: string) => number;
  first: (suffix: string) => Call | undefined;
  last: (suffix: string) => Call | undefined;
}

const jsonRes = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const jwsRes = (jws: string, etag: string): Response =>
  new Response(jws, {
    status: 200,
    headers: { "content-type": "application/jwt", etag },
  });

function mockFetch(initial: MockOpts = {}): MockState {
  const opts: MockOpts = { ...initial };
  const calls: Call[] = [];
  let reacquired = false;
  // §3 anti-replay: a re-issued document must be STRICTLY newer than the one already held for
  // its type. A single monotonic counter gives both slices a strictly increasing sequence
  // without depending on the wall clock ticking between two calls in the same millisecond.
  const at = nowSec();
  let bump = 0;

  const impl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const u = new URL(typeof input === "string" ? input : input.toString());
    const headers = new Headers(init?.headers);
    const call: Call = {
      path: u.pathname,
      method: init?.method ?? "GET",
      ifNoneMatch: headers.get("if-none-match"),
      bearer: headers.get("authorization"),
      device: headers.get("x-pkey-device"),
      version: headers.get("x-pkey-version"),
      channel: headers.get("x-pkey-channel"),
    };
    calls.push(call);
    const device = call.device ?? "d";
    const p = u.pathname;

    // §R1 routes: the mint/rotate/release verbs all live under /license now.
    if (p.endsWith("/license/activate"))
      return jsonRes({ token: "pkeyt_activated", schemaVersion: 1 });
    if (p.endsWith("/license/enroll"))
      return jsonRes({ token: "pkeyt_enrolled", schemaVersion: 1 });
    if (p.endsWith("/license/token")) {
      reacquired = true;
      return jsonRes({ token: "pkeyt_reacquired", schemaVersion: 1 });
    }
    if (p.endsWith("/license/deauthorize")) return jsonRes({});
    // §6 — telemetry is a Core surface now; `/config/report` is gone.
    if (p.endsWith("/devices/report")) return jsonRes({});
    if (p.endsWith("/devices/register"))
      return jsonRes({ token: "pkeyt_registered", deviceId: device });

    if (p.endsWith("/license/document")) {
      if (opts.alwaysUnauthorized) return new Response("", { status: 401 });
      if (opts.unauthorizedUntilReacquire && !reacquired)
        return new Response("", { status: 401 });
      if (opts.licenseBlocked) return jsonRes(opts.blockedBody, 403);
      if (opts.notModified) return new Response(null, { status: 304 });
      return jwsRes(
        await signJws(
          licenseDoc(device, at + bump++),
          TEST_PEM,
          TEST_KID,
          "pkey-license+jws",
        ),
        '"lic-v1"',
      );
    }

    if (p.endsWith("/config/document")) {
      if (opts.alwaysUnauthorized) return new Response("", { status: 401 });
      if (opts.unauthorizedUntilReacquire === "both" && !reacquired)
        return new Response("", { status: 401 });
      if (opts.notModified) return new Response(null, { status: 304 });
      return jwsRes(
        await signJws(
          configDoc(device, at + bump++),
          TEST_PEM,
          TEST_KID,
          "pkey-config+jws",
        ),
        '"cfg-v1"',
      );
    }

    return new Response("", { status: 404 });
  }) as typeof fetch;

  const matching = (suffix: string): Call[] =>
    calls.filter((c) => c.path.endsWith(suffix));
  return {
    impl,
    calls,
    opts,
    count: (suffix) => matching(suffix).length,
    first: (suffix) => matching(suffix)[0],
    last: (suffix) => matching(suffix).at(-1),
  };
}

// ──────────────────────────────────────────────────────────────────────────────────────────

// @pkey-feature license.activate license.entitlements config.secret
describe("PolarisKeyClient — activation + reads", () => {
  it("activate → ok; reads config, entitlement, secret, profile across the SPLIT documents", async () => {
    // The v2 pin read all four off one document. v3 splits them (§2.1/§2.2) and the point of
    // this test is that the split is invisible to a host: one activation still populates the
    // license reads AND the config reads, because `sync()` fetches both in the same pass.
    const client = await PolarisKeyClient.create({
      ...base,
      store: new InMemoryStore(PRODUCT),
      fetchImpl: mockFetch().impl,
    });
    expect(client.status().status).toBe("needs-activation");

    const r = await client.license.activateWithKey(KEY);
    expect(r.kind).toBe("ok");
    expect(client.status().status).toBe("ok");
    expect(client.isLicensed()).toBe(true);

    // …from the LICENSE document
    expect(client.license.isEntitled("polarisVpn")).toBe(true);
    expect(client.license.isEntitled("notAThing")).toBe(false);
    expect(client.license.getEntitlements()).toEqual({ polarisVpn: true });
    expect(client.license.getProfile()?.firstName).toBe("Ada");
    expect(client.license.getLicenseId()).toBe("lic_1");
    expect(client.license.activation()).toBe("token");

    // …from the CONFIG document
    expect(client.getConfig("quality.floor", "any")).toBe("flac");
    expect(client.config.getConfig("quality.floor", "any")).toBe("flac");
    expect(client.getConfig("missing.key", "fallback")).toBe("fallback");
    expect(client.config.getConfigSource("quality.floor")).toBe("enforced");
    expect(client.config.getSecret("soundcloud.oauth")).toBe("tok");
    expect(client.config.getSecret("nope")).toBeNull();
    expect(client.config.schemaVersion()).toBe(4);
    // `hidden` keys are applied but never enumerated; `enforced` ones are shown read-only.
    expect(client.config.listUserConfig()).toEqual([
      { key: "quality.floor", value: "flac", enforced: true },
    ]);
  });

  it("reads return fallbacks/null/empty when no documents are cached", async () => {
    const client = await PolarisKeyClient.create({
      ...base,
      store: new InMemoryStore(PRODUCT),
      fetchImpl: mockFetch().impl,
    });
    expect(client.getConfig("quality.floor", "def")).toBe("def");
    expect(client.config.getSecret("x")).toBeNull();
    expect(client.config.schemaVersion()).toBeNull();
    expect(client.license.isEntitled("polarisVpn")).toBe(false);
    expect(client.license.getEntitlements()).toEqual({});
    expect(client.license.getProfile()).toBeNull();
    expect(client.license.getLicenseId()).toBeNull();
    expect(client.license.activation()).toBeNull();
  });
});

// @pkey-feature core.sync core.cache
describe("PolarisKeyClient — sync / persistence", () => {
  it("activate persists BOTH signed artifacts per slice and reports a snapshot", async () => {
    const store = new InMemoryStore(PRODUCT);
    const m = mockFetch();
    const client = await PolarisKeyClient.create({
      ...base,
      store,
      fetchImpl: m.impl,
    });
    await client.license.activateWithKey(KEY);

    const cache = await store.readCache();
    // §4.1: the SIGNED artifacts are what land on disk — one compact JWS per service, one
    // ETag per service, and nothing decoded.
    expect(cache?.v).toBe(CACHE_VERSION);
    expect(CACHE_VERSION).toBe(3);
    expect(cache?.docs?.license?.split(".")).toHaveLength(3);
    expect(cache?.docs?.config?.split(".")).toHaveLength(3);
    expect(cache?.docs?.license).not.toBe(cache?.docs?.config);
    expect(cache?.etags?.license).toBe('"lic-v1"');
    expect(cache?.etags?.config).toBe('"cfg-v1"');
    // The v1 record's decoded doc and attacker-writable counters, and the v2 record's single
    // `configJws`/`etag` pair, must all stay gone (R4-01/R4-02/R4-03/R4-04).
    expect(cache).not.toHaveProperty("doc");
    expect(cache).not.toHaveProperty("lastAcceptedIssuedAt");
    expect(cache).not.toHaveProperty("lastVerifiedAt");
    expect(cache).not.toHaveProperty("trustedKeys");
    expect(cache).not.toHaveProperty("lastTrustIssuedAt");
    expect(cache).not.toHaveProperty("configJws");
    expect(cache).not.toHaveProperty("etag");

    // …and the derived state still round-trips through the public surface.
    expect(client.getConfig("quality.floor", "x")).toBe("flac");
    expect(client.license.isEntitled("polarisVpn")).toBe(true);
    expect(typeof client.getCurrentDevice().lastVerifiedAt).toBe("number");

    // §6 — the report goes to `POST /<p>/devices/report` (not `/config/report`), bearing the
    // `pkeyt_` device token.
    expect(m.count("/devices/report")).toBeGreaterThanOrEqual(1);
    expect(m.last("/devices/report")?.method).toBe("POST");
    expect(m.last("/devices/report")?.bearer).toBe("Bearer pkeyt_activated");
    expect(m.count("/config/report")).toBe(0);
  });

  it("sends If-None-Match PER DOCUMENT on the second sync, using each slice's own etag", async () => {
    // The two services carry INDEPENDENT validators (§5). Distinct etag values are the whole
    // point of the fixture: crossing the wires would show up here immediately.
    const m = mockFetch();
    const client = await PolarisKeyClient.create({
      ...base,
      store: new InMemoryStore(PRODUCT),
      fetchImpl: m.impl,
    });
    await client.license.activateWithKey(KEY); // first pass is forced: no validators
    expect(m.first("/license/document")?.ifNoneMatch).toBeNull();
    expect(m.first("/config/document")?.ifNoneMatch).toBeNull();

    await client.sync();
    expect(m.last("/license/document")?.ifNoneMatch).toBe('"lic-v1"');
    expect(m.last("/config/document")?.ifNoneMatch).toBe('"cfg-v1"');
  });

  it("sync({force:true}) omits If-None-Match on both documents", async () => {
    const m = mockFetch();
    const client = await PolarisKeyClient.create({
      ...base,
      store: new InMemoryStore(PRODUCT),
      fetchImpl: m.impl,
    });
    await client.license.activateWithKey(KEY);

    await client.sync({ force: true });
    expect(m.last("/license/document")?.ifNoneMatch).toBeNull();
    expect(m.last("/config/document")?.ifNoneMatch).toBeNull();
  });

  it("sync() without a token is a no-op with ZERO fetch calls", async () => {
    // Structural, not incidental: `sync()` returns before the trust refresh and before either
    // document, so an unactivated client that polls generates no traffic at all.
    const m = mockFetch();
    const client = await PolarisKeyClient.create({
      ...base,
      store: new InMemoryStore(PRODUCT),
      fetchImpl: m.impl,
    });
    expect(await client.sync()).toEqual({ applied: false, documents: {} });
    expect(m.calls.length).toBe(0);
  });

  it("performs exactly ONE /license/token re-acquire on a 401, then retries the failed fetch and applies", async () => {
    const m = mockFetch({ unauthorizedUntilReacquire: "license" });
    const client = await PolarisKeyClient.create({
      ...base,
      store: new InMemoryStore(PRODUCT),
      fetchImpl: m.impl,
    });
    // activate stores the token then forces a sync → /license/document 401 → one
    // /license/token → retry → 200.
    const r = await client.license.activateWithKey(KEY);
    expect(r.kind).toBe("ok");
    expect(client.status().status).toBe("ok");
    expect(m.count("/license/token")).toBe(1); // exactly one re-acquire, no retry loop
    const tokenCall = m.first("/license/token");
    expect(tokenCall?.method).toBe("POST");
    expect(tokenCall?.bearer).toBe("Bearer pkeyt_activated");
    expect(tokenCall?.device).toBeTruthy();
  });

  it("performs exactly ONE /license/token re-acquire when BOTH documents 401 in the same parallel pass", async () => {
    // v3-only hazard: `sync()` fetches the two documents concurrently, so two 401s can land at
    // the same instant. §5 still allows exactly ONE re-acquire — `TokenManager` shares the
    // in-flight attempt, so the second document awaits the first's promise instead of opening
    // a second rotation. Without that sharing this test sees either two /license/token calls
    // or a config document stuck on `unauthorized`.
    const m = mockFetch({ unauthorizedUntilReacquire: "both" });
    const store = new InMemoryStore(PRODUCT);
    const client = await PolarisKeyClient.create({
      ...base,
      store,
      fetchImpl: m.impl,
    });
    const r = await client.license.activateWithKey(KEY);

    expect(r.kind).toBe("ok");
    expect(m.count("/license/token")).toBe(1);
    // BOTH documents recovered on the shared re-acquire.
    expect(client.status().status).toBe("ok");
    expect(client.license.isEntitled("polarisVpn")).toBe(true);
    expect(client.getConfig("quality.floor", "x")).toBe("flac");
    const cache = await store.readCache();
    expect(cache?.docs?.license).toBeDefined();
    expect(cache?.docs?.config).toBeDefined();
    expect(cache?.lastSyncUnauthorized).toBe(false);
  });

  it("a persistent 401 lands on revoked with exactly one /license/token attempt", async () => {
    // /license/token happily mints, but the documents keep 401ing → after the single retry
    // (allowReacquire spent) both end `unauthorized`, which is §4.3's offline revocation
    // signal. A retry loop here would hammer the control plane forever and would keep
    // postponing that signal.
    const m = mockFetch({ alwaysUnauthorized: true });
    const client = await PolarisKeyClient.create({
      ...base,
      store: new InMemoryStore(PRODUCT),
      fetchImpl: m.impl,
    });
    await client.license.activateWithKey(KEY);

    expect(client.status().status).toBe("revoked");
    expect(client.isLicensed()).toBe(false);
    expect(m.count("/license/token")).toBe(1);
    expect(client.getSyncState().lastSyncUnauthorized).toBe(true);
  });

  it("403 on /license/document → blocked status with allowedRange, surfaced from the cache", async () => {
    // D-20: the build gate lives on the LICENSE route. The v3 body nests the machine-readable
    // code and keeps `allowedRange` at the top level.
    const m = mockFetch({
      licenseBlocked: true,
      blockedBody: {
        error: { code: "version_blocked", reason: "version-too-old" },
        allowedRange: { min: "2.0.0" },
      },
    });
    const client = await PolarisKeyClient.create({
      ...base,
      store: new InMemoryStore(PRODUCT),
      fetchImpl: m.impl,
    });
    const r = await client.license.activateWithKey(KEY);
    expect(r.kind).toBe("ok"); // activation succeeded; the block is on the document fetch

    const s = client.status();
    expect(s.status).toBe("version-too-old");
    expect(s.allowedRange?.min).toBe("2.0.0");
    expect(client.isLicensed()).toBe(false);
    expect(client.getSyncState().blocked).toEqual({
      reason: "version-too-old",
      allowedRange: { min: "2.0.0" },
    });
    // …and the CONFIG service is untouched by a licence block (§2.2, D-08).
    expect(client.getConfig("quality.floor", "x")).toBe("flac");
  });

  it("403 {error:{code:'channel_not_allowed'}} → channel-not-entitled, with no allowedRange", async () => {
    // The second v3 body shape: a bare code, no `reason`, no range. It must map to the channel
    // block rather than silently falling back to the version block.
    const m = mockFetch({
      licenseBlocked: true,
      blockedBody: { error: { code: "channel_not_allowed" } },
    });
    const client = await PolarisKeyClient.create({
      ...base,
      store: new InMemoryStore(PRODUCT),
      fetchImpl: m.impl,
    });
    await client.license.activateWithKey(KEY);

    const s = client.status();
    expect(s.status).toBe("channel-not-entitled");
    expect(s.allowedRange).toBeUndefined();
    expect(client.isLicensed()).toBe(false);
  });

  it("304 keeps the cached documents and clears a prior block", async () => {
    const m = mockFetch();
    const client = await PolarisKeyClient.create({
      ...base,
      store: new InMemoryStore(PRODUCT),
      fetchImpl: m.impl,
    });
    await client.license.activateWithKey(KEY);
    expect(client.getConfig("quality.floor", "x")).toBe("flac");

    // A build gate closes…
    m.opts.licenseBlocked = true;
    m.opts.blockedBody = {
      error: { code: "version_blocked", reason: "version-too-old" },
      allowedRange: { min: "2.0.0" },
    };
    await client.sync({ force: true });
    expect(client.status().status).toBe("version-too-old");

    // …and then a healthy conditional exchange re-opens it. A 200 OR a 304 is evidence of a
    // live authenticated session, and the unsigned hints can only ever TIGHTEN the gate (§4.1),
    // so clearing them on that evidence is safe.
    m.opts.licenseBlocked = false;
    m.opts.notModified = true;
    const res = await client.sync();
    expect(res.applied).toBe(false);
    expect(res.documents.license?.kind).toBe("unchanged");
    expect(res.documents.config?.kind).toBe("unchanged");
    // The cached documents survive the 304 untouched.
    expect(client.getConfig("quality.floor", "x")).toBe("flac");
    expect(client.license.isEntitled("polarisVpn")).toBe(true);
    expect(client.status().status).toBe("ok");
    expect(client.getSyncState().blocked).toBeNull();
  });
});

// @pkey-feature core.cache
describe("PolarisKeyClient — offline-first init", () => {
  it("init() applies a pre-seeded v3 cache with NO network and reflects ok status", async () => {
    // An offline-first host must be able to render its gate before it has ever reached the
    // control plane, so `init()` is a pure load: device id, token, cache — no fetch.
    const store = new InMemoryStore(PRODUCT);
    const deviceId = await store.getDeviceId();
    const now = nowSec();
    await store.setToken("pkeyt_cached");

    const rec: CacheRecordV3 = {
      v: CACHE_VERSION,
      docs: {
        license: await signJws(
          { ...licenseDoc(deviceId, now), licenseId: "lic_cached" },
          TEST_PEM,
          TEST_KID,
          "pkey-license+jws",
        ),
        config: await signJws(
          configDoc(deviceId, now),
          TEST_PEM,
          TEST_KID,
          "pkey-config+jws",
        ),
      },
      etags: { license: '"lic-v1"', config: '"cfg-v1"' },
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
    expect(client.getConfig("quality.floor", "x")).toBe("flac");
    expect(client.license.isEntitled("polarisVpn")).toBe(true);
    expect(client.license.getLicenseId()).toBe("lic_cached");
    // §4.2 — every counter is recomputed from what just re-verified, not read off the file.
    expect(client.getSyncState().highWaterMark).toBe(now);
    expect(client.getSyncState().lastVerifiedAt).toBe(now * 1000);
  });
});

// @pkey-feature license.deactivate
describe("PolarisKeyClient — deactivate", () => {
  it("deactivate POSTs /license/deauthorize, wipes the store, and resets to needs-activation", async () => {
    const store = new InMemoryStore(PRODUCT);
    const m = mockFetch();
    const client = await PolarisKeyClient.create({
      ...base,
      store,
      fetchImpl: m.impl,
    });
    await client.license.activateWithKey(KEY);
    expect(client.status().status).toBe("ok");

    await client.license.deactivate();
    expect(client.status().status).toBe("needs-activation");
    expect(await store.getToken()).toBeNull();
    expect(await store.readCache()).toBeNull();
    expect(m.last("/license/deauthorize")?.method).toBe("POST");
    expect(m.last("/license/deauthorize")?.bearer).toBe(
      "Bearer pkeyt_activated",
    );
    // The monotonic floor drops only alongside every artifact it was derived from — a floor
    // without its sources would be exactly the bare counter §4.2 abolished.
    expect(client.getSyncState().highWaterMark).toBe(0);
  });

  it("deactivate works offline (deauthorize throws, is swallowed) and still wipes locally", async () => {
    // A device deactivating on a plane must not be left holding a credential because the
    // control plane was unreachable. The LOCAL wipe is the part the caller depends on.
    const store = new InMemoryStore(PRODUCT);
    const m = mockFetch();
    const offline = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const u = new URL(typeof input === "string" ? input : input.toString());
      if (u.pathname.endsWith("/license/deauthorize"))
        throw new Error("offline");
      return m.impl(input, init);
    }) as typeof fetch;

    const client = await PolarisKeyClient.create({
      ...base,
      store,
      fetchImpl: offline,
    });
    await client.license.activateWithKey(KEY);
    await client.license.deactivate();

    expect(client.status().status).toBe("needs-activation");
    expect(await store.getToken()).toBeNull();
    expect(await store.readCache()).toBeNull();
  });
});

// @pkey-feature devices.manage
describe("PolarisKeyClient — device management surface", () => {
  it("reports the current device and only deauthorizes the current device", async () => {
    const store = new InMemoryStore(PRODUCT);
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
    // Without a credential there is no roster to fetch, so the honest answer is this device
    // alone — not an error, and not an empty list.
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
    // Deauthorizing THIS device is a full local deactivation, which needs no server at all.
    await expect(client.deauthorizeDevice(deviceId)).resolves.toBeUndefined();
  });
});

describe("PolarisKeyClient — channel derivation", () => {
  it("derives the channel from the version and sends it as X-PKey-Channel", async () => {
    const m = mockFetch();
    const client = new PolarisKeyClient({
      ...base,
      version: "0.0.0-staging+abc",
      store: new InMemoryStore(PRODUCT),
      fetchImpl: m.impl,
    });
    await client.init();
    await client.license.activateWithKey(KEY);

    // §5 — every product-scoped call carries the client metadata, and the channel is what the
    // server's build gate reads.
    const doc = m.last("/license/document");
    expect(doc?.channel).toBe("staging");
    expect(doc?.version).toBe("0.0.0-staging+abc");
    expect(doc?.device).toBeTruthy();
    expect(m.last("/config/document")?.channel).toBe("staging");
    expect(m.first("/license/activate")?.channel).toBe("staging");
  });
});

describe("PolarisKeyClient — getSyncState (the React bridge contract)", () => {
  it("returns exactly the bridge shape, before and after activation", async () => {
    // §P5's React lane consumes this object field-for-field. Pinning the KEY SET as well as
    // the values is deliberate: silently adding or renaming a field here breaks a consumer in
    // another package that this suite never runs.
    const store = new InMemoryStore(PRODUCT);
    const m = mockFetch();
    const client = await PolarisKeyClient.create({
      ...base,
      store,
      fetchImpl: m.impl,
    });

    const before = client.getSyncState();
    expect(Object.keys(before).sort()).toEqual([
      "activation",
      "blocked",
      "doc",
      "highWaterMark",
      "lastSyncUnauthorized",
      "lastVerifiedAt",
    ]);
    expect(before).toEqual({
      activation: null,
      doc: null,
      lastSyncUnauthorized: false,
      blocked: null,
      lastVerifiedAt: null,
      highWaterMark: 0,
    });

    await client.license.activateWithKey(KEY);

    const after = client.getSyncState();
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    expect(after.activation).toBe("token"); // null → "token"
    expect(after.doc?.licenseId).toBe("lic_1");
    expect(after.doc?.iss).toBe("key.plrs.im");
    expect(after.doc?.deviceId).toBe(await store.getDeviceId());
    expect(after.lastSyncUnauthorized).toBe(false);
    expect(after.blocked).toBeNull();
    expect(typeof after.lastVerifiedAt).toBe("number");
    // The floor is `max(issuedAt)` over what verified — here, the newer of the two documents.
    expect(after.highWaterMark).toBeGreaterThanOrEqual(after.doc!.issuedAt);
  });
});
