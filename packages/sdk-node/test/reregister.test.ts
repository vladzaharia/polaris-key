// @pkey-feature license.reregister
// Re-register on 401 for licence-less devices (wire contract v3 §5, P1b-06).
//
// §5: "exactly one POST /<p>/license/token re-acquire attempt, then one retry of the failed
// fetch. (Registered-without-license devices re-register instead; same single-attempt rule.)"
// These pins cover the route CHOICE (`chooseReacquireRoute`) and the client behaviour around
// it: the licensed path is unchanged, the licence-less path sends a keyless
// `POST /devices/register`, two parallel 401s still make one call, and a refused registration
// records the hard 401 without a second attempt.

import { describe, expect, it } from "vitest";
import { signJws } from "@polaris-key/jws";
import { ISSUER } from "@polaris-key/protocol/core";
import type { ConfigDoc } from "@polaris-key/protocol/config";
import type { LicenseDoc } from "@polaris-key/protocol/license";
import { PolarisKeyClient } from "../src/client.js";
import { chooseReacquireRoute } from "../src/core/token.js";
import { InMemoryStore } from "../src/core/store.js";

const TEST_KID = "pkey-test-prod-2026";
const TEST_PUB = "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI";
const TEST_PEM =
  "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIBlV9cXFJlt08+qaVvnIkgRmgao8P0rhkVh3onqOXPW1\n-----END PRIVATE KEY-----";
const PRODUCT = "djdl";
const nowSec = (): number => Math.floor(Date.now() / 1000);

const base = {
  productSlug: PRODUCT,
  baseUrl: "https://k.test",
  version: "1.2.3",
  trust: { pinnedKeys: { [TEST_KID]: TEST_PUB } },
  trustRefresh: false,
  license: { fingerprint: false },
  devices: { fingerprint: false },
  config: { env: {} },
} as const;

function licenseDoc(deviceId: string, at: number): LicenseDoc {
  return {
    iss: ISSUER,
    aud: PRODUCT,
    deviceId,
    issuedAt: at,
    expiresAt: at + 3600,
    graceUntil: at + 30 * 86400,
    licenseId: "lic_1",
    entitlements: {},
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
    schemaVersion: 1,
    config: {},
    secrets: {},
  };
}

interface Call {
  method: string;
  path: string;
  bearer: string | null;
}

interface Plane {
  impl: typeof fetch;
  calls: Call[];
  count: (suffix: string) => number;
  /** Documents 401 until a mint route has answered 200 — then serve normally. */
  revoked: boolean;
  /** What `POST /devices/register` answers. */
  registerStatus: number;
  /** Documents 401 forever, whatever is minted. */
  alwaysUnauthorized: boolean;
}

function plane(): Plane {
  const calls: Call[] = [];
  let bump = 0;
  const at = nowSec();
  const p: Plane = {
    calls,
    count: (s) => calls.filter((c) => c.path.endsWith(s)).length,
    revoked: false,
    registerStatus: 200,
    alwaysUnauthorized: false,
    impl: (async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(typeof input === "string" ? input : input.toString());
      const h = new Headers(init?.headers);
      calls.push({
        method: init?.method ?? "GET",
        path: u.pathname,
        bearer: h.get("authorization"),
      });
      const device = h.get("x-pkey-device") ?? "d";
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      const path = u.pathname;
      if (path.endsWith("/license/activate"))
        return json({ token: "pkeyt_activated", schemaVersion: 1 });
      if (path.endsWith("/license/token")) {
        p.revoked = false;
        return json({ token: "pkeyt_rotated", schemaVersion: 1 });
      }
      if (path.endsWith("/devices/register")) {
        if (p.registerStatus !== 200)
          return json(
            { error: { code: "registration_closed" } },
            p.registerStatus,
          );
        p.revoked = false;
        return json({ token: "pkeyt_registered", deviceId: device });
      }
      if (path.endsWith("/devices/report")) return json({ ok: true });
      const doc = path.endsWith("/license/document")
        ? "license"
        : path.endsWith("/config/document")
          ? "config"
          : null;
      if (!doc) return new Response("", { status: 404 });
      if (p.alwaysUnauthorized || p.revoked)
        return json({ error: { code: "unauthorized" } }, 401);
      const jws =
        doc === "license"
          ? await signJws(
              licenseDoc(device, at + bump++),
              TEST_PEM,
              TEST_KID,
              "pkey-license+jws",
            )
          : await signJws(
              configDoc(device, at + bump++),
              TEST_PEM,
              TEST_KID,
              "pkey-config+jws",
            );
      return new Response(jws, {
        status: 200,
        headers: { "content-type": "application/jwt", etag: `"${doc}"` },
      });
    }) as typeof fetch,
  };
  return p;
}

describe("chooseReacquireRoute — the path-selection rule", () => {
  it("a licensed device uses /license/token", () => {
    for (const source of ["activate", "enroll", "reacquire", null] as const)
      expect(chooseReacquireRoute({ licenseEnabled: true, source })).toBe(
        "license-token",
      );
  });

  it("License disabled always re-registers", () => {
    for (const source of ["activate", "register", null] as const)
      expect(chooseReacquireRoute({ licenseEnabled: false, source })).toBe(
        "devices-register",
      );
  });

  it("a token minted by register in this process re-registers", () => {
    expect(
      chooseReacquireRoute({ licenseEnabled: true, source: "register" }),
    ).toBe("devices-register");
  });
});

describe("re-register on 401 (§5)", () => {
  it("a licensed device still uses /license/token, never /devices/register", async () => {
    const m = plane();
    const client = await PolarisKeyClient.create({
      ...base,
      store: new InMemoryStore(PRODUCT),
      fetchImpl: m.impl,
    });
    expect((await client.license.activateWithKey("pkey_k")).kind).toBe("ok");
    m.revoked = true;
    const r = await client.sync();
    expect(r.unauthorized).toBeUndefined();
    expect(m.count("/license/token")).toBe(1);
    expect(m.count("/devices/register")).toBe(0);
    expect(client.getSyncState().lastSyncUnauthorized).toBe(false);
  });

  it("a licence-less device re-registers with no Authorization header, stores the token and retries once", async () => {
    const m = plane();
    const store = new InMemoryStore(PRODUCT);
    const client = await PolarisKeyClient.create({
      ...base,
      store,
      fetchImpl: m.impl,
    });
    expect((await client.devices.register()).kind).toBe("ok");
    m.calls.length = 0;
    m.revoked = true;
    // License is enabled by default here: the in-memory source (`register`) is what picks
    // the route.
    const r = await client.sync();
    expect(m.count("/license/token")).toBe(0);
    expect(m.count("/devices/register")).toBe(1);
    const reg = m.calls.find((c) => c.path.endsWith("/devices/register"))!;
    expect(reg.method).toBe("POST");
    expect(reg.bearer).toBeNull();
    // The new token is stored and the retry carried it.
    expect(await store.getToken()).toBe("pkeyt_registered");
    expect(r.unauthorized).toBeUndefined();
    expect(r.documents.config?.kind).toBe("applied");
  });

  it("after a restart with License enabled, an unknown-source token keeps /license/token (the sync-errors transcript)", async () => {
    // A licensed device with an empty cache and a licence-less one look the same after a
    // restart; the recorded transcript pins this state to /license/token.
    const m = plane();
    const store = new InMemoryStore(PRODUCT);
    await store.setToken("pkeyt_from_a_previous_run");
    const client = await PolarisKeyClient.create({
      ...base,
      store,
      fetchImpl: m.impl,
    });
    m.revoked = true;
    await client.sync();
    expect(m.count("/license/token")).toBe(1);
    expect(m.count("/devices/register")).toBe(0);
  });

  it("a product with License disabled re-registers with no Authorization header", async () => {
    const m = plane();
    const store = new InMemoryStore(PRODUCT);
    await store.setToken("pkeyt_old");
    const client = await PolarisKeyClient.create({
      ...base,
      expectedServices: ["config"],
      store,
      fetchImpl: m.impl,
    });
    m.revoked = true;
    const r = await client.sync();
    expect(m.count("/license/document")).toBe(0);
    expect(m.count("/license/token")).toBe(0);
    expect(m.count("/devices/register")).toBe(1);
    expect(
      m.calls.find((c) => c.path.endsWith("/devices/register"))!.bearer,
    ).toBeNull();
    expect(r.documents.config?.kind).toBe("applied");
  });

  it("two parallel 401s cause exactly one register call", async () => {
    const m = plane();
    const store = new InMemoryStore(PRODUCT);
    const client = await PolarisKeyClient.create({
      ...base,
      store,
      fetchImpl: m.impl,
    });
    expect((await client.devices.register()).kind).toBe("ok");
    m.calls.length = 0;
    // License AND config enabled (the suite default), so both documents are fetched in
    // parallel and both 401 at once.
    m.revoked = true;
    const r = await client.sync();
    expect(m.count("/license/document")).toBe(2);
    expect(m.count("/config/document")).toBe(2);
    expect(m.count("/devices/register")).toBe(1);
    expect(m.count("/license/token")).toBe(0);
    expect(r.documents.license?.kind).toBe("applied");
    expect(r.documents.config?.kind).toBe("applied");
  });

  it("a 403 registration_closed records the hard 401 and makes no second attempt", async () => {
    const m = plane();
    const store = new InMemoryStore(PRODUCT);
    const client = await PolarisKeyClient.create({
      ...base,
      store,
      fetchImpl: m.impl,
    });
    expect((await client.devices.register()).kind).toBe("ok");
    m.calls.length = 0;
    m.revoked = true;
    m.registerStatus = 403;
    const r = await client.sync();
    expect(m.count("/devices/register")).toBe(1);
    expect(m.count("/license/token")).toBe(0);
    // One fetch per document: no retry after a failed attempt.
    expect(m.count("/license/document")).toBe(1);
    expect(m.count("/config/document")).toBe(1);
    expect(r.unauthorized).toBe(true);
    expect(client.getSyncState().lastSyncUnauthorized).toBe(true);
    expect(await store.getToken()).toBe("pkeyt_registered");
  });

  it("a minted token that still 401s spends the attempt; the next pass re-arms it", async () => {
    const m = plane();
    const store = new InMemoryStore(PRODUCT);
    await store.setToken("pkeyt_old");
    const client = await PolarisKeyClient.create({
      ...base,
      expectedServices: ["config"],
      store,
      fetchImpl: m.impl,
    });
    m.alwaysUnauthorized = true;
    const r = await client.sync();
    expect(r.unauthorized).toBe(true);
    expect(m.count("/devices/register")).toBe(1);
    expect(m.count("/config/document")).toBe(2);
    await client.sync();
    expect(m.count("/devices/register")).toBe(2);
  });
});
