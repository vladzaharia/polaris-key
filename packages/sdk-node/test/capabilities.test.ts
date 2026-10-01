// @pkey-feature core.discover
// Capability resolution (D-21) and the React bridge contract — the two things the suite's
// service split makes newly breakable, pinned end to end against a mock control plane.
//
// ── THE RESOLUTION LADDER ───────────────────────────────────────────────────────────────────
//
// `CoreContext.services()` answers "which services does this product run?" with NO network call,
// in strict precedence:
//
//   1. a discovery document loaded THIS SESSION (`client.discover()`) — always wins;
//   2. `CoreOptions.expectedServices` — what this build was compiled expecting;
//   3. `DEFAULT_SERVICES` — license ON, config ON, release/distribution/update/identity OFF.
//
// Both halves matter and both are here. The FAIL-CLOSED half: release, update and identity are
// off until something says otherwise, and `ctx.requireService(slug)` makes a sub-client of a
// service this product does not run throw `PolarisError("service-unavailable")` BEFORE it dials.
// The OFFLINE-FIRST half: discovery is a network read, so an unreachable control plane must
// never be able to take a licence gate away — a 500 on `/.well-known/polaris.json` leaves
// whatever was already resolved exactly where it was.
//
// ── D-08, THE REASON ANY OF THIS EXISTS ─────────────────────────────────────────────────────
//
// Before v3 "device" was a licensing concept, so a product that wanted only managed settings
// still had to pretend to be licensed. D-08 splits them: a config-only product registers a
// device keylessly, fetches a config document on that plain device token, and reports its gate
// as `not-applicable` with `isUsable: true` — usable, not "needs-activation" forever. The
// `describe` block below walks that whole flow at the wire level and asserts the thing that
// makes it a GUARANTEE rather than a convention: `/license/document` is never requested at all.
//
// ── THE BRIDGE CONTRACT ─────────────────────────────────────────────────────────────────────
//
// `getSyncState()` is the single snapshot P5's React lane renders from. Its KEY SET is part of
// the contract — a field silently added or dropped is a bridge that compiles and then renders
// nothing — so the shape is asserted by `Object.keys(...).sort()`, not just by field.

import { afterEach, describe, expect, it } from "vitest";
import { signJws } from "@polaris-key/jws";
import { ISSUER } from "@polaris-key/protocol/core";
import type { ConfigDoc } from "@polaris-key/protocol/config";
import type { LicenseDoc } from "@polaris-key/protocol/license";
import { PolarisError } from "@polaris-key/client-core";
import { PolarisKeyClient } from "../src/client.js";
import { InMemoryStore } from "../src/core/store.js";
import type { ServiceSlug } from "../src/discovery.js";

const TEST_KID = "pkey-test-prod-2026";
const TEST_PUB = "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI";
const TEST_PEM =
  "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIBlV9cXFJlt08+qaVvnIkgRmgao8P0rhkVh3onqOXPW1\n-----END PRIVATE KEY-----";

const PRODUCT = "djdl";
const BASE_URL = "https://k.test";
const KEY = "pkey_djdl_test";
const WELL_KNOWN = "/.well-known/polaris.json";
const nowSec = (): number => Math.floor(Date.now() / 1000);

/** Every slug off — the baseline a `ServicesMap` assertion is spread over. */
const NONE = {
  license: { enabled: false },
  config: { enabled: false },
  release: { enabled: false },
  distribution: { enabled: false },
  update: { enabled: false },
  identity: { enabled: false },
};

/** Fingerprinting off everywhere: these tests pin capability wiring, not hardware probes.
 *  `trustRefresh:false` keeps the signed clock out of the picture so `highWaterMark`
 *  assertions have exactly one source. */
const base = {
  productSlug: PRODUCT,
  baseUrl: BASE_URL,
  version: "1.2.3",
  trust: { pinnedKeys: { [TEST_KID]: TEST_PUB } },
  trustRefresh: false,
  license: { fingerprint: false },
  devices: { fingerprint: false },
  config: { env: {} },
};

// ── Harness ───────────────────────────────────────────────────────────────────────────────

type Route = (req: {
  url: URL;
  headers: Headers;
}) => Response | Promise<Response>;

interface Mock {
  impl: typeof fetch;
  /** Every request path, in order. */
  calls: string[];
  hit: (suffix: string) => number;
}

/** A fetch routed by path SUFFIX, longest match first. Anything unrouted 404s — which is what
 *  makes "this route was never requested" assertable rather than merely likely. */
function mockFetch(routes: Record<string, Route>): Mock {
  const suffixes = Object.keys(routes).sort((a, b) => b.length - a.length);
  const calls: string[] = [];
  const impl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : String(input));
    calls.push(url.pathname);
    const headers = new Headers(init?.headers);
    for (const suffix of suffixes) {
      const route = routes[suffix];
      if (route && url.pathname.endsWith(suffix))
        return route({ url, headers });
    }
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  return {
    impl,
    calls,
    hit: (suffix) => calls.filter((p) => p.endsWith(suffix)).length,
  };
}

const open: PolarisKeyClient[] = [];
afterEach(() => {
  for (const client of open.splice(0)) client.close();
});

async function makeClient(
  fetchImpl: typeof fetch,
  opts: { expectedServices?: ServiceSlug[] } = {},
): Promise<PolarisKeyClient> {
  const client = await PolarisKeyClient.create({
    ...base,
    store: new InMemoryStore(PRODUCT),
    fetchImpl,
    ...(opts.expectedServices
      ? { expectedServices: opts.expectedServices }
      : {}),
  });
  open.push(client);
  return client;
}

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────

function licenseDoc(deviceId: string, issuedAt: number): LicenseDoc {
  return {
    iss: ISSUER,
    aud: PRODUCT,
    deviceId,
    issuedAt,
    expiresAt: issuedAt + 3600,
    graceUntil: issuedAt + 30 * 86400,
    licenseId: "lic_djdl_1",
    entitlements: {
      "license.tier": { state: "enforced", value: "pro", updatedAt: issuedAt },
    },
  };
}

function configDoc(deviceId: string, issuedAt: number): ConfigDoc {
  return {
    iss: ISSUER,
    aud: PRODUCT,
    deviceId,
    issuedAt,
    expiresAt: issuedAt + 3600,
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

/**
 * The Worker's discovery emission, trimmed to what capability resolution reads. Slugs the
 * caller does not list are OMITTED rather than written as `{enabled:false}` — so every one of
 * these fixtures also exercises the fail-closed read of an absent slug.
 */
function discoveryDoc(
  services: Partial<Record<ServiceSlug, Record<string, unknown>>>,
): Record<string, unknown> {
  const product = `${BASE_URL}/${PRODUCT}`;
  return {
    version: 2,
    protocolVersion: 4,
    schemaVersion: 4,
    product: PRODUCT,
    slug: PRODUCT,
    name: "DJDL",
    baseUrl: BASE_URL,
    core: {
      registration: "open",
      endpoints: {
        discovery: `${product}${WELL_KNOWN}`,
        devices: `${product}/devices`,
        register: `${product}/devices/register`,
      },
    },
    trust: { trustManifestUrl: `${product}/.well-known/polaris-trust.jws` },
    services,
  };
}

// ── 1. The default ────────────────────────────────────────────────────────────────────────
// D-21's fail-closed half. License and Config are on because every product has run them since
// before the suite existed; the three genuinely new services are off until advertised.
describe("capabilities — the suite default (D-21)", () => {
  it("resolves license+config ON and release/distribution/update/identity OFF with no document and no expectation", async () => {
    const client = await makeClient(mockFetch({}).impl);

    expect(client.capabilities()).toEqual({
      ...NONE,
      license: { enabled: true },
      config: { enabled: true },
    });
    // The licence gate is live, so an unactivated client reports the normal v2 state.
    expect(client.license.status().status).toBe("needs-activation");
    expect(client.isLicensed()).toBe(false);
    expect(client.config.enabled).toBe(true);
  });

  it("refuses a sub-client whose service was never advertised — BEFORE it dials", async () => {
    const m = mockFetch({});
    const client = await makeClient(m.impl);

    await expect(client.release.changelog()).rejects.toBeInstanceOf(
      PolarisError,
    );
    await expect(client.release.changelog()).rejects.toMatchObject({
      code: "service-unavailable",
    });
    await expect(client.update.check()).rejects.toMatchObject({
      code: "service-unavailable",
    });
    // The URL builders refuse too: the gate is on the service, not on the round trip.
    expect(() => client.release.installUrl()).toThrow(PolarisError);
    expect(() => client.release.downloadUrl("1.0.0", "djdl", "arm64")).toThrow(
      PolarisError,
    );
    // A client that has not been told the service exists must not probe for it.
    expect(m.calls).toEqual([]);
  });
});

// ── 2. The expectedServices fallback ──────────────────────────────────────────────────────
// The offline-first half. Naming the expectation at construction is how a config-only or
// release-enabled product gets the right answer with no round trip at all.
describe("capabilities — the expectedServices fallback (D-08/D-21)", () => {
  it("a config-only product boots USABLE, not needs-activation", async () => {
    const client = await makeClient(mockFetch({}).impl, {
      expectedServices: ["config"],
    });

    expect(client.capabilities()).toEqual({
      ...NONE,
      config: { enabled: true },
    });
    // D-08: there is no licence here to be missing, so the gate short-circuits rather than
    // holding the product hostage to an activation that will never happen.
    expect(client.license.status().status).toBe("not-applicable");
    expect(client.isLicensed()).toBe(true);
    expect(client.config.enabled).toBe(true);
  });

  it("names release as expected — and update is still refused", async () => {
    const m = mockFetch({
      "/release/changelog": () =>
        json({
          entries: [
            {
              version: "1.3.0",
              tag: "v1.3.0",
              date: "2026-08-01",
              summary: "Faster imports",
              url: "https://example.test/releases/v1.3.0",
            },
          ],
        }),
    });
    const client = await makeClient(m.impl, {
      expectedServices: ["license", "release"],
    });

    await expect(client.release.changelog()).resolves.toEqual([
      expect.objectContaining({ version: "1.3.0", tag: "v1.3.0" }),
    ]);
    expect(m.hit("/release/changelog")).toBe(1);
    // Update was not named, so it stays off even though its sibling service is on — the two
    // are separate services precisely so a product can want a changelog without wanting Sparkle.
    expect(client.capabilities().update).toEqual({ enabled: false });
    await expect(client.update.check()).rejects.toMatchObject({
      code: "service-unavailable",
    });
    expect(m.hit("/update/version")).toBe(0);
  });
});

// ── 3. Discovery wins ─────────────────────────────────────────────────────────────────────
// The expectation is what this BUILD believed; the document is what the PRODUCT says. Once
// loaded, the document wins in both directions — it can take a service away and it can grant one.
describe("capabilities — a discovery document wins (D-21)", () => {
  it("turns the licence gate off against a build that expected it", async () => {
    const m = mockFetch({
      [WELL_KNOWN]: () =>
        json(
          discoveryDoc({
            license: { enabled: false },
            config: { enabled: true, endpoints: {} },
          }),
        ),
    });
    const client = await makeClient(m.impl, { expectedServices: ["license"] });

    expect(client.license.status().status).toBe("needs-activation");

    const res = await client.discover();
    expect(res.kind).toBe("ok");
    expect(client.capabilities()).toEqual({
      ...NONE,
      config: { enabled: true },
    });
    expect(client.license.status().status).toBe("not-applicable");
    expect(client.isLicensed()).toBe(true);
    expect(client.config.enabled).toBe(true);
  });

  it("turns a service ON that no expectation named", async () => {
    const m = mockFetch({
      [WELL_KNOWN]: () =>
        json(
          discoveryDoc({
            release: {
              enabled: true,
              configured: true,
              endpoints: {
                changelog: `${BASE_URL}/${PRODUCT}/release/changelog`,
              },
            },
          }),
        ),
      "/release/changelog": () => json({ entries: [] }),
    });
    // `expectedServices: []` is a real expectation — it says "nothing", not "use the default".
    const client = await makeClient(m.impl, { expectedServices: [] });

    expect(client.capabilities()).toEqual(NONE);
    await expect(client.release.changelog()).rejects.toMatchObject({
      code: "service-unavailable",
    });

    await client.discover();
    expect(client.capabilities()).toEqual({
      ...NONE,
      release: { enabled: true },
    });
    await expect(client.release.changelog()).resolves.toEqual([]);
  });
});

// ── 4. Discovery unreachable ──────────────────────────────────────────────────────────────
// Discovery is a NETWORK read on an offline-first client. A control plane we could not reach
// told us nothing — which is not the same as telling us the product runs nothing.
describe("capabilities — an unreachable control plane changes nothing", () => {
  it("a 500 leaves the offline fallback intact and reports the failure", async () => {
    const m = mockFetch({
      [WELL_KNOWN]: () => new Response("boom", { status: 500 }),
    });
    const client = await makeClient(m.impl, { expectedServices: ["license"] });

    const res = await client.discover();

    expect(res.kind).toBe("error");
    expect(res.kind === "error" ? res.status : 0).toBe(500);
    // The licence gate survives: losing it here would lock every offline user out of a product
    // whose control plane merely hiccuped.
    expect(client.capabilities()).toEqual({
      ...NONE,
      license: { enabled: true },
    });
    expect(client.license.status().status).toBe("needs-activation");
  });

  it("a 500 does not roll back a document already loaded this session", async () => {
    let phase: "ok" | "down" = "ok";
    const m = mockFetch({
      [WELL_KNOWN]: () =>
        phase === "ok"
          ? json(discoveryDoc({ release: { enabled: true } }))
          : new Response("", { status: 500 }),
      "/release/changelog": () => json({ entries: [] }),
    });
    const client = await makeClient(m.impl, { expectedServices: [] });

    await client.discover();
    expect(client.capabilities().release).toEqual({ enabled: true });

    phase = "down";
    expect((await client.discover()).kind).toBe("error");
    expect(client.capabilities().release).toEqual({ enabled: true });
    await expect(client.release.changelog()).resolves.toEqual([]);
  });
});

// ── 5. The config-only product, end to end ────────────────────────────────────────────────
// The wire-level proof of D-08: a device principal with a real credential, a signed config
// document fetched on it, and no licence anywhere in the exchange.
describe("the config-only product flow (D-08)", () => {
  it("registers keylessly, syncs ONLY the config document, and gates as not-applicable", async () => {
    const issuedAt = nowSec();
    const m = mockFetch({
      "/devices/register": ({ headers }) =>
        json({
          token: "pkeyt_reg",
          // The server echoes the principal the client announced in `X-PKey-Device`.
          deviceId: headers.get("x-pkey-device") ?? "",
        }),
      "/config/document": async ({ headers }) =>
        new Response(
          await signJws(
            configDoc(headers.get("x-pkey-device") ?? "", issuedAt),
            TEST_PEM,
            TEST_KID,
            "pkey-config+jws",
          ),
          {
            status: 200,
            headers: { "content-type": "application/jwt", etag: '"cfg-1"' },
          },
        ),
      "/devices/report": () => json({}),
    });
    const client = await makeClient(m.impl, { expectedServices: ["config"] });

    const registered = await client.devices.register();
    expect(registered.kind).toBe("ok");
    expect(registered.kind === "ok" ? registered.token : "").toBe("pkeyt_reg");
    expect(registered.kind === "ok" ? registered.deviceId : "").toBe(
      client.core.deviceId,
    );
    // The credential is real and persisted — that is what "registered device" means in v3 §6.
    expect(registered.kind === "ok" ? registered.token : "").toMatch(/^pkeyt_/);

    const synced = await client.sync();

    expect(synced.applied).toBe(true);
    expect(synced.documents.config?.kind).toBe("applied");
    // A service this product does not run is not merely skipped in the result — it is never
    // reported on, because it was never fetched.
    expect(synced.documents.license).toBeUndefined();
    expect(m.hit("/config/document")).toBe(1);
    expect(m.hit("/license/document")).toBe(0);
    expect(m.calls.filter((p) => p.includes("/license/"))).toEqual([]);

    // The document resolved through the config service's own accessors…
    expect(client.config.getConfig("quality.floor", "mp3")).toBe("flac");
    expect(client.getConfig("quality.floor", "mp3")).toBe("flac");
    expect(client.config.schemaVersion()).toBe(4);

    // …and the licence gate reports "there is no licence here", usably.
    expect(client.license.status().status).toBe("not-applicable");
    expect(client.isLicensed()).toBe(true);

    const state = client.getSyncState();
    // A registered device holds a real credential, so it IS activated — by token…
    expect(state.activation).toBe("token");
    // …and there is no licence document behind it. Both halves are the point of D-08.
    expect(state.doc).toBeNull();
    expect(state.highWaterMark).toBe(issuedAt);
  });
});

// ── 6. The bridge contract ────────────────────────────────────────────────────────────────
// One snapshot, six keys, assembled from the managers that own each piece. The KEY SET is
// asserted, not just the values: P5's React lane destructures this shape.
describe("getSyncState() — the React bridge contract", () => {
  const BRIDGE_KEYS = [
    "activation",
    "blocked",
    "doc",
    "highWaterMark",
    "lastSyncUnauthorized",
    "lastVerifiedAt",
  ];

  it("(a) fresh and unactivated: exactly the six keys, all empty, with no network", async () => {
    const m = mockFetch({});
    const client = await makeClient(m.impl);

    const state = client.getSyncState();

    expect(Object.keys(state).sort()).toEqual(BRIDGE_KEYS);
    expect(state).toEqual({
      activation: null,
      doc: null,
      lastSyncUnauthorized: false,
      blocked: null,
      lastVerifiedAt: null,
      highWaterMark: 0,
    });
    // `init()` is offline-first: a host renders its gate before ever reaching the control plane.
    expect(m.calls).toEqual([]);
  });

  it("(b) after a licence activation: token, the verified doc, and the floor at its issuedAt", async () => {
    const issuedAt = nowSec();
    const m = mockFetch({
      "/license/activate": () => json({ token: "pkeyt_act", schemaVersion: 4 }),
      "/license/document": async ({ headers }) =>
        new Response(
          await signJws(
            licenseDoc(headers.get("x-pkey-device") ?? "", issuedAt),
            TEST_PEM,
            TEST_KID,
            "pkey-license+jws",
          ),
          { status: 200, headers: { etag: '"lic-1"' } },
        ),
      "/devices/report": () => json({}),
    });
    const client = await makeClient(m.impl, { expectedServices: ["license"] });

    expect((await client.license.activateWithKey(KEY)).kind).toBe("ok");
    const state = client.getSyncState();

    expect(Object.keys(state).sort()).toEqual(BRIDGE_KEYS);
    expect(state.activation).toBe("token");
    expect(state.doc?.licenseId).toBe("lic_djdl_1");
    expect(state.doc?.deviceId).toBe(client.core.deviceId);
    // §4.2: the floor is the signed `issuedAt` of what verified — never a local counter.
    expect(state.highWaterMark).toBe(issuedAt);
    expect(typeof state.lastVerifiedAt).toBe("number");
    expect(state.lastVerifiedAt).toBeGreaterThan(0);
    expect(state.lastSyncUnauthorized).toBe(false);
    expect(state.blocked).toBeNull();
    expect(client.license.status().status).toBe("ok");
  });

  it("(c) a recorded hard 401 sets lastSyncUnauthorized without discarding the document", async () => {
    const issuedAt = nowSec();
    let phase: "live" | "revoked" = "live";
    const m = mockFetch({
      "/license/activate": () => json({ token: "pkeyt_act", schemaVersion: 4 }),
      // §5's single re-acquire: it is attempted exactly once and it fails here too.
      "/license/token": () => new Response("", { status: 401 }),
      "/license/document": async ({ headers }) => {
        if (phase === "revoked") return new Response("", { status: 401 });
        return new Response(
          await signJws(
            licenseDoc(headers.get("x-pkey-device") ?? "", issuedAt),
            TEST_PEM,
            TEST_KID,
            "pkey-license+jws",
          ),
          { status: 200, headers: { etag: '"lic-1"' } },
        );
      },
      "/devices/report": () => json({}),
    });
    const client = await makeClient(m.impl, { expectedServices: ["license"] });
    await client.license.activateWithKey(KEY);

    phase = "revoked";
    const synced = await client.sync();
    const state = client.getSyncState();

    expect(synced.unauthorized).toBe(true);
    expect(m.hit("/license/token")).toBe(1);
    expect(Object.keys(state).sort()).toEqual(BRIDGE_KEYS);
    expect(state.lastSyncUnauthorized).toBe(true);
    // The signed document is still held: §4.3's offline revocation is an unsigned HINT layered
    // over it, not an erasure of what was verified.
    expect(state.doc?.licenseId).toBe("lic_djdl_1");
    expect(state.activation).toBe("token");
    expect(client.license.status().status).toBe("revoked");
    expect(client.isLicensed()).toBe(false);
  });

  it("(d) a 403 build block surfaces its reason and allowedRange", async () => {
    const m = mockFetch({
      "/license/activate": () => json({ token: "pkeyt_act", schemaVersion: 4 }),
      // v3 nests the machine-readable code and keeps `allowedRange` at the top level (§5/D-20).
      "/license/document": () =>
        json(
          {
            error: { code: "version_blocked", reason: "version-too-old" },
            allowedRange: { min: "2.0.0" },
          },
          403,
        ),
      "/devices/report": () => json({}),
    });
    const client = await makeClient(m.impl, { expectedServices: ["license"] });

    // Activation itself succeeded; the block is on the DOCUMENT, which is where D-20 puts the
    // build gate.
    expect((await client.license.activateWithKey(KEY)).kind).toBe("ok");
    const state = client.getSyncState();

    expect(Object.keys(state).sort()).toEqual(BRIDGE_KEYS);
    expect(state.blocked).toEqual({
      reason: "version-too-old",
      allowedRange: { min: "2.0.0" },
    });
    expect(state.doc).toBeNull();
    expect(state.activation).toBe("token");
    expect(state.lastSyncUnauthorized).toBe(false);

    const status = client.license.status();
    expect(status.status).toBe("version-too-old");
    expect(status.allowedRange?.min).toBe("2.0.0");
    expect(client.isLicensed()).toBe(false);
  });
});
