// `sync()` — the single Core loop that replaced v2's `refresh()`, and everything that hangs
// off it. This file is the heir of the pre-suite `refreshLoop.test.ts`: the opt-in polling
// timer and the `onChange` callback that make remote re-licensing land without a restart are
// still pinned here, plus the four rules that are new because Core now drives the loop rather
// than the config service:
//
//   §5  ETag/304 half-life, PER DOCUMENT. `computeETag()` excludes issuedAt/expiresAt/
//       graceUntil, so a content-stable document 304s forever and a continuously online client
//       would coast into `grace` at `expiresAt` behind a validator that never changes (R2-11).
//       Past `expiresAt − REFRESH_MARGIN_SECONDS` the client re-asks UNCONDITIONALLY, and it
//       does so per slice — the two documents carry independent windows.
//   §4.2 Trust refresh is CORE's, on Core's own cadence, before and independently of whichever
//       documents this product fetches. v2 rode it on the `/config` fetch, so a product that
//       fetched no config advanced no signed clock.
//   §2.2/D-08  the enabled documents are fetched IN PARALLEL, and a service this product does
//       not run is never requested at all.
//   §5  the per-document outcome map a caller reads to tell "nothing changed" from "the server
//       refused me".
//
// The `onChange` signal remains the ETag, now per slice: a differing tag means the CONTENT
// changed, not merely that the document was re-signed.

import { afterEach, describe, expect, it, vi } from "vitest";
import { signJws } from "@plrs/jws";
import { ISSUER } from "@plrs/protocol/core";
import type { ConfigDoc } from "@plrs/protocol/config";
import type { LicenseDoc } from "@plrs/protocol/license";
import type { TrustManifestDoc } from "@plrs/protocol/trust";
import type { LicenseState } from "@plrs/client-core";
import { PolarisClient } from "../src/client.js";
import { InMemoryStore } from "../src/core/store.js";

const TEST_KID = "pkey-test-prod-2026";
const TEST_PUB = "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI";
const TEST_PEM =
  "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIBlV9cXFJlt08+qaVvnIkgRmgao8P0rhkVh3onqOXPW1\n-----END PRIVATE KEY-----";

const PRODUCT = "djdl";
const BASE_URL = "https://k.test";
const KEY = "pkey_djdl_test";
const TRUST_PATH = "/.well-known/polaris-trust.jws";
const nowSec = (): number => Math.floor(Date.now() / 1000);

const base = {
  productSlug: PRODUCT,
  baseUrl: BASE_URL,
  version: "1.2.3",
  trust: { pinnedKeys: { [TEST_KID]: TEST_PUB } },
  license: { fingerprint: false },
  devices: { fingerprint: false },
  config: { env: {} },
} as const;

afterEach(() => {
  vi.useRealTimers();
});

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────

function licenseDoc(
  deviceId: string,
  issuedAt: number,
  tier = "free",
  ttl = 3600,
): LicenseDoc {
  return {
    iss: ISSUER,
    aud: PRODUCT,
    deviceId,
    issuedAt,
    expiresAt: issuedAt + ttl,
    graceUntil: issuedAt + 30 * 86400,
    licenseId: "lic_1",
    profile: {
      name: "Ada Lovelace",
      firstName: "Ada",
      email: "ada@example.com",
      activatedAt: issuedAt,
    },
    entitlements: {
      "license.tier": { state: "enforced", value: tier, updatedAt: issuedAt },
    },
  };
}

function configDoc(deviceId: string, issuedAt: number, ttl = 3600): ConfigDoc {
  return {
    iss: ISSUER,
    aud: PRODUCT,
    deviceId,
    issuedAt,
    expiresAt: issuedAt + ttl,
    graceUntil: issuedAt + 30 * 86400,
    schemaVersion: 4,
    config: {
      "quality.floor": {
        state: "enforced",
        value: "flac",
        updatedAt: issuedAt,
      },
    },
    secrets: {},
  };
}

function trustManifest(issuedAt: number): TrustManifestDoc {
  return {
    schemaVersion: 1,
    aud: PRODUCT,
    iss: ISSUER,
    issuedAt,
    expiresAt: issuedAt + 300,
    jwksUrl: `${BASE_URL}/${PRODUCT}/.well-known/jwks.json`,
    cacheSeconds: 300,
    keys: [
      {
        kid: TEST_KID,
        alg: "EdDSA",
        kty: "OKP",
        crv: "Ed25519",
        publicKey: TEST_PUB,
        status: "active",
      },
    ],
  };
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

// ── The refresh-loop / onChange scenario (carried from refreshLoop.test.ts) ────────────────

interface Scenario {
  client: PolarisClient;
  changes: LicenseState[];
  paths: string[];
  /** Swap what the next /license/document returns, as a remote tier change would. */
  setTier: (tier: string, etag: string) => void;
}

async function scenario(
  opts: { refreshIntervalSeconds?: number } = {},
): Promise<Scenario> {
  let tier = "free";
  let licenseEtag = '"lic-1"';
  const configEtag = '"cfg-1"';
  // Anti-replay (§3) requires a strictly increasing `issuedAt` per document type: a re-issued
  // document reusing the previous timestamp is rejected by the verifier and never applied.
  let issuedAt = nowSec();
  const changes: LicenseState[] = [];
  const paths: string[] = [];
  const store = new InMemoryStore(PRODUCT);
  const deviceId = await store.getDeviceId();

  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const p = new URL(typeof input === "string" ? input : input.toString())
      .pathname;
    paths.push(p);
    const validator = new Headers(init?.headers).get("if-none-match");

    if (p.endsWith("/license/activate"))
      return jsonRes({ token: "plrst_test", schemaVersion: 1 });
    if (p.endsWith("/devices/report")) return jsonRes({});

    if (p.endsWith("/license/document")) {
      if (validator === licenseEtag)
        return new Response(null, {
          status: 304,
          headers: { etag: licenseEtag },
        });
      return jwsRes(
        await signJws(
          licenseDoc(deviceId, issuedAt, tier),
          TEST_PEM,
          TEST_KID,
          "plrs-license+jws",
        ),
        licenseEtag,
      );
    }
    if (p.endsWith("/config/document")) {
      if (validator === configEtag)
        return new Response(null, {
          status: 304,
          headers: { etag: configEtag },
        });
      return jwsRes(
        await signJws(
          configDoc(deviceId, issuedAt),
          TEST_PEM,
          TEST_KID,
          "plrs-config+jws",
        ),
        configEtag,
      );
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const client = await PolarisClient.create({
    ...base,
    store,
    fetchImpl,
    trustRefresh: false,
    onChange: (s) => changes.push(s),
    ...opts,
  });
  await client.license.activateWithKey(KEY);

  return {
    client,
    changes,
    paths,
    setTier: (nextTier, nextEtag) => {
      tier = nextTier;
      licenseEtag = nextEtag;
      issuedAt += 60;
    },
  };
}

describe("refresh loop", () => {
  it("is off unless an interval is configured", async () => {
    // Enabling polling by default would silently add network traffic and background wakeups
    // to every already-shipped integration.
    // Fake timers must be installed BEFORE the client is constructed — startTimer() calls
    // setInterval during init(), so a later swap would leave a real timer running.
    vi.useFakeTimers();
    const s = await scenario();
    const spy = vi.spyOn(s.client, "sync");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(spy).not.toHaveBeenCalled();
    s.client.close();
  });

  it("polls on the configured interval and stops on close()", async () => {
    vi.useFakeTimers();
    const s = await scenario({ refreshIntervalSeconds: 10 });
    const spy = vi.spyOn(s.client, "sync");

    await vi.advanceTimersByTimeAsync(25_000);
    const whileRunning = spy.mock.calls.length;
    expect(whileRunning).toBeGreaterThanOrEqual(2);

    s.client.close();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(spy.mock.calls.length).toBe(whileRunning);
  });

  it("close() is safe to call twice", async () => {
    const s = await scenario({ refreshIntervalSeconds: 10 });
    s.client.close();
    expect(() => s.client.close()).not.toThrow();
  });
});

describe("onChange", () => {
  it("fires when the entitlements actually change (a new etag on one slice)", async () => {
    const s = await scenario();
    s.changes.length = 0;

    s.setTier("pro", '"lic-2"');
    const r = await s.client.sync();

    expect(s.changes).toHaveLength(1);
    expect(s.changes[0]?.status).toBe("ok");
    expect(s.client.license.getEntitlements()["license.tier"]).toBe("pro");
    // Only the LICENSE slice moved; config still 304s, which is exactly the independence the
    // split ETags buy (a tier change no longer forces a settings refetch).
    expect(r.documents.license?.kind).toBe("applied");
    expect(r.documents.config?.kind).toBe("unchanged");
    s.client.close();
  });

  it("does not fire when both documents are unchanged (304)", async () => {
    // A 304 means the content is identical; firing onChange there would make every poll look
    // like a re-licensing event.
    const s = await scenario();
    s.changes.length = 0;

    const r = await s.client.sync();
    expect(r.applied).toBe(false);
    expect(s.changes).toHaveLength(0);
    s.client.close();
  });
});

describe("sync — the ETag/304 half-life rule, per document (R2-11)", () => {
  it("304s inside the half-life and re-asks UNCONDITIONALLY past expiresAt − REFRESH_MARGIN_SECONDS", async () => {
    // The attack this closes is passive: serve a content-stable ETag forever. The client keeps
    // 304ing, the signed validity window never advances, and a continuously ONLINE, fully
    // AUTHENTICATED client silently degrades to `grace` and then `expired`.
    //
    // The fixture gives the two documents DIFFERENT lifetimes (license 3600s, config 7200s) so
    // the escalation boundary lands at a different moment for each. That is what makes this a
    // per-document pin rather than a global one: at t0+2000 the license doc is past its
    // half-life and the config doc is not, and exactly one of them must escalate.
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = 1_800_000_000;
    vi.setSystemTime(t0 * 1000);

    const LICENSE_TTL = 3600; // escalate past issuedAt + 1800
    const CONFIG_TTL = 7200; // escalate past issuedAt + 5400
    const served = { license: 0, config: 0 };
    const store = new InMemoryStore(PRODUCT);
    const deviceId = await store.getDeviceId();

    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const p = new URL(typeof input === "string" ? input : input.toString())
        .pathname;
      const validator = new Headers(init?.headers).get("if-none-match");

      if (p.endsWith("/license/activate"))
        return jsonRes({ token: "plrst_stable", schemaVersion: 1 });
      if (p.endsWith("/devices/report")) return jsonRes({});

      if (p.endsWith("/license/document")) {
        // Content-stable: the tag NEVER changes, so only an unconditional ask gets bytes.
        if (validator === '"stable-lic"')
          return new Response(null, { status: 304 });
        served.license += 1;
        return jwsRes(
          await signJws(
            licenseDoc(deviceId, nowSec(), "free", LICENSE_TTL),
            TEST_PEM,
            TEST_KID,
            "plrs-license+jws",
          ),
          '"stable-lic"',
        );
      }
      if (p.endsWith("/config/document")) {
        if (validator === '"stable-cfg"')
          return new Response(null, { status: 304 });
        served.config += 1;
        return jwsRes(
          await signJws(
            configDoc(deviceId, nowSec(), CONFIG_TTL),
            TEST_PEM,
            TEST_KID,
            "plrs-config+jws",
          ),
          '"stable-cfg"',
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const client = await PolarisClient.create({
      ...base,
      store,
      fetchImpl,
      trustRefresh: false,
    });
    await client.license.activateWithKey(KEY);
    expect(served).toEqual({ license: 1, config: 1 });
    expect(client.getSyncState().doc?.issuedAt).toBe(t0);

    // ── Inside both half-lives: the server serves the document ONCE and 304s thereafter.
    vi.setSystemTime((t0 + 600) * 1000);
    const inside = await client.sync();
    expect(inside.documents.license?.kind).toBe("unchanged");
    expect(inside.documents.config?.kind).toBe("unchanged");
    expect(served).toEqual({ license: 1, config: 1 });
    expect(client.getSyncState().doc?.issuedAt).toBe(t0); // window NOT advanced by a 304

    // ── Past the LICENSE half-life only (t0+2000 > t0+1800, but < t0+5400).
    vi.setSystemTime((t0 + 2000) * 1000);
    const licenseOnly = await client.sync();
    expect(licenseOnly.documents.license?.kind).toBe("applied");
    expect(licenseOnly.documents.config?.kind).toBe("unchanged");
    expect(served).toEqual({ license: 2, config: 1 });
    expect(client.getSyncState().doc?.issuedAt).toBe(t0 + 2000);

    // ── Past BOTH: the licence's new window (t0+2000 … t0+5600) is half-spent at t0+3800 and
    //    the config's original window (t0 … t0+7200) at t0+5400.
    vi.setSystemTime((t0 + 5500) * 1000);
    const both = await client.sync();
    expect(both.documents.license?.kind).toBe("applied");
    expect(both.documents.config?.kind).toBe("applied");
    expect(served).toEqual({ license: 3, config: 2 });

    // The whole point: t0+5500 is well past the FIRST licence document's `expiresAt` (t0+3600).
    // Without the escalation this client would be sitting in `grace` right now, online and
    // authenticated the entire time.
    expect(client.status().status).toBe("ok");
    expect(client.getSyncState().doc?.issuedAt).toBe(t0 + 5500);
    expect(client.getSyncState().doc?.expiresAt).toBe(t0 + 5500 + LICENSE_TTL);
    client.close();
  });
});

describe("sync — trust refresh on Core's own cadence (§4.2)", () => {
  /** A control plane whose documents are broken but whose trust manifest is healthy. */
  function trustOnlyFetch(manifestJws: string, paths: string[]): typeof fetch {
    return (async (input: string | URL | Request): Promise<Response> => {
      const p = new URL(typeof input === "string" ? input : input.toString())
        .pathname;
      paths.push(p);
      if (p.endsWith(TRUST_PATH))
        return new Response(manifestJws, {
          status: 200,
          headers: { "content-type": "application/jose" },
        });
      if (p.endsWith("/devices/report")) return jsonRes({});
      // Both documents are down.
      return new Response("boom", { status: 500 });
    }) as typeof fetch;
  }

  it("fetches and persists the trust manifest even when BOTH documents fail", async () => {
    // v2's floor rode the `/config` fetch, which meant a product that fetched no config (or
    // whose config service was down) advanced no signed clock — and a floor built from a
    // document alone is provably inert, because `doc.issuedAt < doc.graceUntil` always holds
    // (R4-04). Core drives this now, before the documents and independently of them.
    const store = new InMemoryStore(PRODUCT);
    await store.setToken("plrst_seeded"); // sync() needs a credential to do anything at all
    const at = nowSec();
    const manifestJws = await signJws(
      trustManifest(at),
      TEST_PEM,
      TEST_KID,
      "plrs-trust+jws",
    );
    const paths: string[] = [];

    const client = await PolarisClient.create({
      ...base,
      store,
      trustRefresh: true,
      fetchImpl: trustOnlyFetch(manifestJws, paths),
    });
    const r = await client.sync();

    expect(paths.filter((p) => p.endsWith(TRUST_PATH))).toHaveLength(1);
    expect(r.applied).toBe(false);
    expect(r.documents.license?.kind).toBe("error");
    expect(r.documents.config?.kind).toBe("error");

    // The VERIFIED manifest is persisted as a compact JWS — never as a bare `kid → key` map,
    // which is what made a file write a key-substitution primitive in v1 (R2-01/R4-02).
    const cache = await store.readCache();
    expect(cache?.trustJws).toBe(manifestJws);
    expect(cache).not.toHaveProperty("trustedKeys");
    // …and its `issuedAt` raised the monotonic floor, with no document having verified at all.
    expect(client.getSyncState().highWaterMark).toBe(at);
    client.close();
  });

  it("never fetches the trust manifest when trustRefresh is false", async () => {
    const store = new InMemoryStore(PRODUCT);
    await store.setToken("plrst_seeded");
    const manifestJws = await signJws(
      trustManifest(nowSec()),
      TEST_PEM,
      TEST_KID,
      "plrs-trust+jws",
    );
    const paths: string[] = [];

    const client = await PolarisClient.create({
      ...base,
      store,
      trustRefresh: false,
      fetchImpl: trustOnlyFetch(manifestJws, paths),
    });
    await client.sync();

    expect(paths.some((p) => p.endsWith(TRUST_PATH))).toBe(false);
    expect((await store.readCache())?.trustJws).toBeUndefined();
    expect(client.getSyncState().highWaterMark).toBe(0);
    client.close();
  });
});

// ── Per-service parallel fetch (D-08 / D-21) ──────────────────────────────────────────────

interface ServiceMock {
  impl: typeof fetch;
  paths: string[];
}

async function serviceMock(store: InMemoryStore): Promise<ServiceMock> {
  const deviceId = await store.getDeviceId();
  const paths: string[] = [];
  const at = nowSec();
  let bump = 0;
  const impl = (async (input: string | URL | Request): Promise<Response> => {
    const p = new URL(typeof input === "string" ? input : input.toString())
      .pathname;
    paths.push(p);
    if (p.endsWith("/license/activate"))
      return jsonRes({ token: "plrst_activated", schemaVersion: 1 });
    if (p.endsWith("/devices/register"))
      return jsonRes({ token: "plrst_registered", deviceId });
    if (p.endsWith("/devices/report")) return jsonRes({});
    if (p.endsWith("/license/document"))
      return jwsRes(
        await signJws(
          licenseDoc(deviceId, at + bump++),
          TEST_PEM,
          TEST_KID,
          "plrs-license+jws",
        ),
        '"lic-v1"',
      );
    if (p.endsWith("/config/document"))
      return jwsRes(
        await signJws(
          configDoc(deviceId, at + bump++),
          TEST_PEM,
          TEST_KID,
          "plrs-config+jws",
        ),
        '"cfg-v1"',
      );
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { impl, paths };
}

describe("sync — per-service parallel fetch (D-08 / D-21)", () => {
  it("with only the license service enabled, /config/document is NEVER requested", async () => {
    const store = new InMemoryStore(PRODUCT);
    const m = await serviceMock(store);
    const client = await PolarisClient.create({
      ...base,
      store,
      fetchImpl: m.impl,
      trustRefresh: false,
      expectedServices: ["license"],
    });
    expect(client.capabilities().license.enabled).toBe(true);
    expect(client.capabilities().config.enabled).toBe(false);

    await client.license.activateWithKey(KEY);
    const r = await client.sync({ force: true });

    expect(m.paths.some((p) => p.endsWith("/config/document"))).toBe(false);
    expect(m.paths.filter((p) => p.endsWith("/license/document"))).toHaveLength(
      2,
    );
    expect(r.documents.license?.kind).toBe("applied");
    // A disabled service is absent from the outcome map entirely — the internal `skipped`
    // outcome is filtered out rather than reported, so a caller cannot mistake "this product
    // does not run config" for "config was attempted and produced nothing".
    expect("config" in r.documents).toBe(false);
    expect(r.documents.config).toBeUndefined();

    expect(client.status().status).toBe("ok");
    expect(client.getConfig("quality.floor", "fallback")).toBe("fallback");
    client.close();
  });

  it("with only the config service enabled, /license/document is never requested and the gate is not-applicable + usable", async () => {
    // D-08: a config-only product's installs get an identity and a credential from
    // `POST /devices/register`, keylessly, and must boot USABLE rather than sitting on
    // `needs-activation` forever waiting for a licence that does not exist.
    const store = new InMemoryStore(PRODUCT);
    const m = await serviceMock(store);
    const client = await PolarisClient.create({
      ...base,
      store,
      fetchImpl: m.impl,
      trustRefresh: false,
      expectedServices: ["config"],
    });

    const registration = await client.devices.register();
    expect(registration.kind).toBe("ok");
    const r = await client.sync({ force: true });

    expect(m.paths.some((p) => p.endsWith("/license/document"))).toBe(false);
    expect("license" in r.documents).toBe(false);
    expect(r.documents.config?.kind).toBe("applied");
    expect(r.applied).toBe(true);

    expect(client.status().status).toBe("not-applicable");
    expect(client.isLicensed()).toBe(true);
    expect(client.getConfig("quality.floor", "x")).toBe("flac");
    // No licence document ⇒ no grants, and nothing pretends otherwise.
    expect(client.license.getEntitlements()).toEqual({});
    client.close();
  });
});

describe("sync — the per-document result shape", () => {
  it("reports applied → unchanged → blocked → unauthorized per document", async () => {
    // The outcome map is what a caller reads to tell "nothing changed" from "the server
    // refused me", per service. `error` (a 5xx or a dropped connection) is covered by the
    // trust-cadence test above; `skipped` is never surfaced — a disabled service's slice is
    // omitted from the map (see the D-21 tests).
    const store = new InMemoryStore(PRODUCT);
    const deviceId = await store.getDeviceId();
    const at = nowSec();
    let bump = 0;
    let mode: "ok" | "blocked" | "unauthorized" = "ok";

    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const p = new URL(typeof input === "string" ? input : input.toString())
        .pathname;
      const validator = new Headers(init?.headers).get("if-none-match");
      if (p.endsWith("/license/activate"))
        return jsonRes({ token: "plrst_activated", schemaVersion: 1 });
      if (p.endsWith("/license/token"))
        return jsonRes({ token: "plrst_rotated", schemaVersion: 1 });
      if (p.endsWith("/devices/report")) return jsonRes({});

      if (p.endsWith("/license/document")) {
        if (mode === "unauthorized") return new Response("", { status: 401 });
        if (mode === "blocked")
          return jsonRes(
            {
              error: { code: "version_blocked", reason: "version-too-old" },
              allowedRange: { min: "2.0.0" },
            },
            403,
          );
        if (validator === '"lic-v1"')
          return new Response(null, { status: 304 });
        return jwsRes(
          await signJws(
            licenseDoc(deviceId, at + bump++),
            TEST_PEM,
            TEST_KID,
            "plrs-license+jws",
          ),
          '"lic-v1"',
        );
      }
      if (p.endsWith("/config/document")) {
        if (mode === "unauthorized") return new Response("", { status: 401 });
        if (validator === '"cfg-v1"')
          return new Response(null, { status: 304 });
        return jwsRes(
          await signJws(
            configDoc(deviceId, at + bump++),
            TEST_PEM,
            TEST_KID,
            "plrs-config+jws",
          ),
          '"cfg-v1"',
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const client = await PolarisClient.create({
      ...base,
      store,
      fetchImpl,
      trustRefresh: false,
    });

    // applied — the forced pass activation triggers.
    await client.license.activateWithKey(KEY);
    expect(client.getSyncState().doc).not.toBeNull();

    // unchanged — both validators still match.
    const unchanged = await client.sync();
    expect(unchanged).toEqual({
      applied: false,
      documents: {
        license: { kind: "unchanged" },
        config: { kind: "unchanged" },
      },
    });

    // blocked — the build gate closes on the LICENSE route only (D-20); config is unaffected.
    mode = "blocked";
    const blocked = await client.sync({ force: true });
    expect(blocked.blocked).toBe(true);
    expect(blocked.applied).toBe(true); // the config document still landed
    expect(blocked.documents.license).toEqual({
      kind: "blocked",
      blocked: {
        reason: "version-too-old",
        allowedRange: { min: "2.0.0" },
      },
    });
    expect(blocked.documents.config?.kind).toBe("applied");

    // unauthorized — both documents 401 after the single re-acquire is spent.
    mode = "unauthorized";
    const unauthorized = await client.sync({ force: true });
    expect(unauthorized.unauthorized).toBe(true);
    expect(unauthorized.applied).toBe(false);
    expect(unauthorized.documents.license?.kind).toBe("unauthorized");
    expect(unauthorized.documents.config?.kind).toBe("unauthorized");
    expect(client.getSyncState().lastSyncUnauthorized).toBe(true);
    // Both unsigned hints are now set, and they STAY set: neither document produced a healthy
    // exchange (§5 clears them on a 200 or a 304 and on nothing else), so a 401 is no evidence
    // that the earlier build gate was lifted. The gate reports the STRICTER, more specific of
    // the two — `blocked` is checked before `revoked` — which is the §4.1 rule that these
    // hints may only ever tighten. `revoked` on a clean 401 has its own pin in client.test.ts.
    expect(client.getSyncState().blocked?.reason).toBe("version-too-old");
    expect(client.status().status).toBe("version-too-old");
    expect(client.isLicensed()).toBe(false);
    client.close();
  });
});
