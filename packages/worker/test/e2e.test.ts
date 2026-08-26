// True end-to-end flow over the REAL worker handlers (makeTestDb + KvMock) feeding the
// REAL Node SDK (@plrs/node). Nothing here re-implements server or client logic:
// the doc is minted by handleActivate→handleConfig, verified by the SDK's frozen JWS path,
// gated by `licenseState`, and read back through the layered `PolarisKeyClient.getConfig`.
// This is the cross-package contract test the per-package unit suites can't cover alone.

import { describe, expect, it } from "vitest";
import { verifyJws } from "@plrs/jws";
import type { ManagedConfigDoc, ManagedEntry } from "@plrs/protocol";
import {
  licenseState,
  isUsable,
  verifyDoc,
  CACHE_VERSION,
  InMemoryStore,
  PolarisKeyClient,
} from "@plrs/node";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import {
  makeEnv,
  mkReq,
  NOW,
  seedLicenseWithKey,
  seedProduct,
  DJDL_CATALOG,
  TEST_KID,
  TEST_PUB,
} from "./seed.js";
import { loadProduct, type Product } from "../src/product.js";
import { handleConfig, handleActivate } from "../src/licensing.js";
import type { Env } from "../src/env.js";
import type { SqliteDb } from "../src/db/sqlite.js";

// The trust set a real client would pin: the product's kid → its published Ed25519 pubkey.
const TRUST = { [TEST_KID]: TEST_PUB };
const enforced = (value: ManagedEntry["value"]): ManagedEntry => ({
  state: "enforced",
  value,
  updatedAt: NOW,
});

interface World {
  db: SqliteDb;
  kv: KvMock;
  env: Env;
  product: Product;
}

async function bootstrap(
  opts: { config?: Record<string, ManagedEntry> } = {},
): Promise<World & { key: string; licenseId: string }> {
  const db = makeTestDb();
  const kv = new KvMock();
  const env = makeEnv(kv, ["djdl"]);
  // Seed with the REAL djdl catalog so config keys survive handleConfig's validatePayload prune.
  await seedProduct(db, "djdl", { catalog: DJDL_CATALOG });
  const product = (await loadProduct(env, db, "djdl"))!;
  expect(product).toBeTruthy();
  const { key, licenseId } = await seedLicenseWithKey(db, "djdl", {
    entitlements: { polarisVpn: enforced(true) },
    config: opts.config,
  });
  return { db, kv, env, product, key, licenseId };
}

/** Drive activate (key→token) then /config (token→signed JWS) through the real handlers. */
async function activateAndFetch(
  w: World,
  key: string,
  device: string,
  now = NOW,
): Promise<{ jws: string; etag: string }> {
  const activateRes = await handleActivate(
    mkReq("POST", { authorization: `Bearer ${key}`, "x-pkey-device": device }),
    w.env,
    w.db,
    w.product,
    now,
  );
  expect(activateRes.status).toBe(200);
  const { token } = (await activateRes.json()) as { token: string };

  const cfgRes = await handleConfig(
    mkReq("GET", {
      authorization: `Bearer ${token}`,
      "x-pkey-version": "1.2.3",
    }),
    w.env,
    w.db,
    w.product,
    now,
  );
  expect(cfgRes.status).toBe(200);
  const etag = cfgRes.headers.get("etag")!;
  return { jws: await cfgRes.text(), etag };
}

/** Build a real PolarisKeyClient over an InMemoryStore pre-seeded with the SIGNED doc, so
 *  getConfig()/status() run the genuine layered resolver + gate (offline, no network).
 *  Wire contract v2 §4.1: the cache holds the compact JWS, which init() re-verifies against
 *  the pinned trust set — the decoded doc and its counters are derived, never stored. */
async function clientWithCachedDoc(
  jws: string,
  device: string,
  localOverrides?: Record<string, unknown>,
): Promise<PolarisKeyClient> {
  const store = new InMemoryStore("djdl");
  // The client binds doc.deviceId === its own device id; align the store's id to the doc.
  (store as unknown as { deviceId: string }).deviceId = device;
  await store.setToken("pkeyt_cached");
  await store.writeCache({ v: CACHE_VERSION, configJws: jws });
  const client = new PolarisKeyClient({
    productSlug: "djdl",
    version: "1.2.3",
    trust: { pinnedKeys: TRUST },
    store,
    localOverrides: localOverrides as Record<string, never> | undefined,
  });
  await client.init();
  return client;
}

describe("e2e: worker handlers → JWS → Node SDK gate", () => {
  it("activate → config → verifyJws → licenseState reports ok", async () => {
    const w = await bootstrap({
      config: { "quality.losslessOnly": enforced(true) },
    });
    const { jws } = await activateAndFetch(w, w.key, "dev-1");

    // 1) The frozen JWS path verifies under the product's pinned pubkey.
    const v = await verifyJws<ManagedConfigDoc>(jws, TRUST);
    expect(v).not.toBeNull();
    expect(v!.kid).toBe(TEST_KID);

    // 2) The decoded ManagedConfigDoc carries the wire contract the SDK relies on.
    const doc = v!.payload;
    expect(doc.aud).toBe("djdl");
    expect(doc.iss).toBe("key.plrs.im");
    expect(doc.deviceId).toBe("dev-1");
    expect(doc.licenseId).toBe(w.licenseId);
    expect(doc.issuedAt).toBe(NOW);

    // 3) v2 entries carry management `state` + `updatedAt` (not bare values).
    const cfgEntry = doc.payload.config["quality.losslessOnly"];
    expect(cfgEntry).toEqual({
      state: "enforced",
      value: true,
      updatedAt: NOW,
    });
    expect(doc.payload.entitlements.polarisVpn).toEqual({
      state: "enforced",
      value: true,
      updatedAt: NOW,
    });

    // 4) The SDK's verifyDoc (aud/device/replay checks) accepts it for THIS device.
    const sdkDoc = await verifyDoc(jws, {
      trust: TRUST,
      expectedAud: "djdl",
      deviceId: "dev-1",
      // The fixtures mint documents at the fixed epoch NOW; verifyDoc asserts the §3
      // freshness window, so the evaluation time must be stated rather than read off the wall.
      now: NOW,
    });
    expect(sdkDoc).not.toBeNull();

    // 5) The real SDK gate reports `ok` (fresh doc, has token, not blocked).
    const state = licenseState({ hasToken: true, doc: sdkDoc, now: NOW });
    expect(state.status).toBe("ok");
    expect(isUsable(state.status)).toBe(true);
  });

  it("the SDK's verifyDoc rejects a doc spliced to a different device (anti-replay)", async () => {
    const w = await bootstrap();
    const { jws } = await activateAndFetch(w, w.key, "dev-1");
    // Same valid JWS, wrong device binding ⇒ the SDK refuses to apply it.
    const wrongDevice = await verifyDoc(jws, {
      trust: TRUST,
      expectedAud: "djdl",
      deviceId: "dev-OTHER",
    });
    expect(wrongDevice).toBeNull();
  });

  it("offline → online transition: cache a doc, let it expire to grace/expired, then re-fetch to ok", async () => {
    const w = await bootstrap();
    const { jws } = await activateAndFetch(w, w.key, "dev-1");
    const doc = await verifyDoc(jws, {
      trust: TRUST,
      expectedAud: "djdl",
      deviceId: "dev-1",
      // The fixtures mint documents at the fixed epoch NOW; verifyDoc asserts the §3
      // freshness window, so the evaluation time must be stated rather than read off the wall.
      now: NOW,
    });
    expect(doc).not.toBeNull();

    // The real client, offline, reads its cached doc and reports `ok` while fresh.
    const client = await clientWithCachedDoc(jws, "dev-1");
    expect(client.status(NOW).status).toBe("ok");
    expect(client.isLicensed(NOW)).toBe(true);

    // Offline + past expiresAt (short) but within graceUntil (long): keeps running in grace.
    const inGrace = doc!.expiresAt + 60;
    expect(inGrace).toBeLessThan(doc!.graceUntil);
    expect(client.status(inGrace).status).toBe("grace");
    expect(client.isLicensed(inGrace)).toBe(true);

    // Offline + past graceUntil: the cached doc no longer suffices → expired (not usable).
    const expired = doc!.graceUntil + 60;
    expect(client.status(expired).status).toBe("expired");
    expect(client.isLicensed(expired)).toBe(false);

    // Back online at that later time: a freshly-minted doc re-establishes `ok` with a
    // strictly-newer issuedAt (the SDK's monotonic-issuedAt replay guard accepts it).
    const { jws: jws2 } = await activateAndFetch(w, w.key, "dev-1", expired);
    const doc2 = await verifyDoc(jws2, {
      trust: TRUST,
      expectedAud: "djdl",
      deviceId: "dev-1",
      lastAcceptedIssuedAt: doc!.issuedAt,
      now: expired,
    });
    expect(doc2).not.toBeNull();
    expect(doc2!.issuedAt).toBeGreaterThan(doc!.issuedAt);
    expect(
      licenseState({ hasToken: true, doc: doc2, now: expired }).status,
    ).toBe("ok");
  });

  it("ENFORCED override: getConfig returns the server value even with a conflicting localOverride", async () => {
    // Admin enforces quality.losslessOnly=true on the license; the doc carries it as `enforced`.
    const w = await bootstrap({
      config: { "quality.losslessOnly": enforced(true) },
    });
    const { jws } = await activateAndFetch(w, w.key, "dev-1");
    const doc = await verifyDoc(jws, {
      trust: TRUST,
      expectedAud: "djdl",
      deviceId: "dev-1",
      // The fixtures mint documents at the fixed epoch NOW; verifyDoc asserts the §3
      // freshness window, so the evaluation time must be stated rather than read off the wall.
      now: NOW,
    });
    expect(doc!.payload.config["quality.losslessOnly"]?.state).toBe("enforced");

    // The real client, given a CONFLICTING localOverride, must still surface the server value
    // for the enforced key — the client cannot override an enforced config entry.
    const client = await clientWithCachedDoc(jws, "dev-1", {
      "quality.losslessOnly": false,
    });
    expect(client.getConfig("quality.losslessOnly", false)).toBe(true); // server wins
    expect(client.getConfigSource("quality.losslessOnly")).toBe("enforced");

    // A `default`-state key, by contrast, IS overridable by the client (proves the override
    // path is wired and only the `enforced` state is locking the value above).
    const w2 = await bootstrap({
      config: {
        "quality.floor": { state: "default", value: "any", updatedAt: NOW },
      },
    });
    const { jws: jws2 } = await activateAndFetch(w2, w2.key, "dev-1");
    const doc2 = await verifyDoc(jws2, {
      trust: TRUST,
      expectedAud: "djdl",
      deviceId: "dev-1",
      // The fixtures mint documents at the fixed epoch NOW; verifyDoc asserts the §3
      // freshness window, so the evaluation time must be stated rather than read off the wall.
      now: NOW,
    });
    const client2 = await clientWithCachedDoc(jws2, "dev-1", {
      "quality.floor": "flac",
    });
    expect(client2.getConfig("quality.floor", "any")).toBe("flac"); // client override beats a default
  });
});
