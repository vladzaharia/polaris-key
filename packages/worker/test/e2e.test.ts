// True end-to-end wire contract v3, over the REAL worker handlers (makeTestDb + KvMock) feeding
// the REAL reference client (`@plrs/client-core`). Nothing here re-implements server or client
// logic: the documents are minted by handleRegister / handleActivate → handleLicenseDocument /
// handleConfigDocument / handleTrustManifest, verified by client-core's frozen JWS + claim path,
// gated by `licenseState` against the monotonic floor, and read back through client-core's
// layered config resolver. This is the cross-package contract test the per-package unit suites
// cannot cover alone.
//
// ── WHY client-core AND NOT @plrs/node ──────────────────────────────────────────────────────
//
// This file used to drive `@plrs/node`'s client over the fused v2 document. Wire v3 splits that
// document in two, so `@plrs/node` — whose verifier demands `typ: "pkey-config+jws"`, whose
// expected `iss` is `key.plrs.im`, and whose cache record holds a single `configJws` — cannot
// consume what the worker now signs. Re-shaping the Node SDK is P4. What this file does is run
// the complete v3 flow against the same worker code, expressed over the reference client that
// already speaks v3.
//
// ── THE SHAPE OF THE FLOW ───────────────────────────────────────────────────────────────────
//
//   registration policy → activate → both documents → verify → gate
//     → ETag/304 per document
//     → offline reload (re-verify from cache with the reload profile, fold the floor,
//        walk ok → grace → expired, refuse a wound-back clock)
//     → 401 → single token re-acquire → retry
//     → deauthorize wipes
//     → and the whole thing again with NO licence service at all (D-08)
//
// Each `it` owns one leg, so a failure names the leg.

import { describe, expect, it } from "vitest";
import {
  effectiveNow,
  highWaterMark,
  isUsable,
  licenseState,
  mergeTrust,
  resolveSource,
  resolveValue,
  verifyConfigDoc,
  verifyLicenseDoc,
  verifyTrustManifest,
  type ResolveContext,
} from "@plrs/client-core";
import type { ManagedEntry } from "@plrs/protocol";
import type { LicenseDoc } from "@plrs/protocol/license";
import type { ConfigDoc } from "@plrs/protocol/config";
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
import { loadProduct, type Product } from "../src/core/products.js";
import {
  handleActivate,
  handleDeauthorize,
  handleToken,
} from "../src/services/license/activation.js";
import { handleLicenseDocument } from "../src/services/license/document.js";
import { handleConfigDocument } from "../src/services/config/document.js";
import { handleTrustManifest } from "../src/core/trust.js";
import { handleRegister } from "../src/core/register.js";
import { SERVICES } from "../src/mount.js";
import { handleReport } from "../src/core/devices.js";
import { serializeServices, type ServicesMap } from "../src/core/services.js";
import { setServices } from "../src/repo.js";
import type { Env } from "../src/env.js";
import type { SqliteDb } from "../src/db/sqlite.js";

/** The trust set a real client would PIN: the product's kid → its published Ed25519 pubkey. */
const TRUST = { [TEST_KID]: TEST_PUB };
/** A well-formed device id — 32 base64url chars, the shape §6 states and every SDK derives. */
const DEVICE = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH";

const enforced = (value: ManagedEntry["value"]): ManagedEntry => ({
  state: "enforced",
  value,
  updatedAt: NOW,
});

const CONFIG_ONLY: ServicesMap = {
  license: { enabled: false },
  config: { enabled: true },
  release: { enabled: false },
  update: { enabled: false },
  identity: { enabled: false },
};

interface World {
  db: SqliteDb;
  kv: KvMock;
  env: Env;
  product: Product;
}

async function bootstrap(
  opts: { config?: Record<string, ManagedEntry>; services?: ServicesMap } = {},
): Promise<World & { key: string; licenseId: string }> {
  const db = makeTestDb();
  const kv = new KvMock();
  const env = makeEnv(kv, ["djdl"]);
  // Seed with the REAL djdl catalog so config keys survive the pre-sign prune.
  await seedProduct(db, "djdl", { catalog: DJDL_CATALOG });
  if (opts.services) {
    await setServices(
      db,
      "djdl",
      serializeServices({ services: opts.services }),
      "manifest",
      NOW,
    );
  }
  const product = (await loadProduct(env, db, "djdl"))!;
  expect(product).toBeTruthy();
  const { key, licenseId } = await seedLicenseWithKey(db, "djdl", {
    entitlements: { polarisVpn: enforced(true) },
    config: opts.config,
  });
  return { db, kv, env, product, key, licenseId };
}

/**
 * Everything a v3 client persists after one successful sync (cache record v3 §4.1): signed
 * artifacts only, plus the per-document ETags.
 */
interface Cache {
  trustJws: string;
  docs: { license: string; config: string };
  etags: { license: string; config: string };
}

/** One core sync: the trust manifest, then the enabled services' documents. */
async function sync(w: World, token: string, now = NOW): Promise<Cache> {
  const req = (): Request =>
    mkReq("GET", {
      authorization: `Bearer ${token}`,
      "x-polaris-version": "1.2.3",
    });

  // Core refreshes trust on its OWN schedule — not as a side effect of a document fetch
  // (§4.2). Doing it first here mirrors that ordering.
  const trustRes = await handleTrustManifest(
    new Request(
      "https://key.plrs.im/djdl/.well-known/polaris-trust.jws",
    ) as unknown as Request,
    w.db,
    w.product,
    now,
  );
  expect(trustRes.status).toBe(200);

  const licRes = await handleLicenseDocument(
    req(),
    w.env,
    w.db,
    w.product,
    now,
  );
  expect(licRes.status).toBe(200);
  const cfgRes = await handleConfigDocument(req(), w.env, w.db, w.product, now);
  expect(cfgRes.status).toBe(200);

  return {
    trustJws: await trustRes.text(),
    docs: { license: await licRes.text(), config: await cfgRes.text() },
    etags: {
      license: licRes.headers.get("etag")!,
      config: cfgRes.headers.get("etag")!,
    },
  };
}

/** Drive activate (key → token) then a full sync through the real handlers. */
async function activateAndSync(
  w: World,
  key: string,
  device: string,
  now = NOW,
): Promise<{ token: string; cache: Cache }> {
  const activateRes = await handleActivate(
    mkReq("POST", {
      authorization: `Bearer ${key}`,
      "x-polaris-device": device,
    }),
    w.env,
    w.db,
    w.product,
    now,
  );
  expect(activateRes.status).toBe(200);
  const { token } = (await activateRes.json()) as { token: string };
  return { token, cache: await sync(w, token, now) };
}

const verifyOpts = (
  device: string,
  now: number,
): Parameters<typeof verifyLicenseDoc>[1] => ({
  trust: TRUST,
  expectedAud: "djdl",
  deviceId: device,
  // The fixtures mint documents at a fixed epoch and the verifier asserts the §3 freshness
  // window, so the evaluation time must be stated rather than read off the wall.
  now,
});

/**
 * The cache RELOAD path (§4.1): re-verify everything from the record — trust against PINS
 * only, then each document against the effective set with `checkFreshness: false`, because a
 * cached document is *expected* to be past its short `expiresAt`. Any failure makes that
 * artifact absent rather than partially trusted.
 */
async function reload(
  cache: Cache,
  device: string,
  systemNow: number,
): Promise<{
  license: LicenseDoc | null;
  config: ConfigDoc | null;
  now: number;
  floor: number;
}> {
  const trust = await verifyTrustManifest(cache.trustJws, {
    pinned: TRUST,
    expectedAud: "djdl",
    now: systemNow,
    checkFreshness: false,
  });
  expect(trust.doc).not.toBeNull();
  // `mergeTrust(discovered, pinned)` — pins spread last, so a manifest can never shadow one
  // (§1 rule 1). The documents verify against the EFFECTIVE set, never against pins alone.
  const opts = {
    ...verifyOpts(device, systemNow),
    trust: mergeTrust(trust.discovered, TRUST),
    checkFreshness: false,
  };
  const license = await verifyLicenseDoc(cache.docs.license, opts);
  const config = await verifyConfigDoc(cache.docs.config, opts);

  // The floor folds every RE-VERIFIED artifact, the trust manifest included — a floor built
  // from documents alone is provably inert (§4.2).
  const floor = highWaterMark(
    [trust.doc, license, config].filter(
      (a): a is NonNullable<typeof a> => a !== null,
    ),
  );
  return { license, config, now: effectiveNow(systemNow, floor), floor };
}

/** The resolver context a host would build: the verified remote map plus local layers. */
const ctx = (
  doc: ConfigDoc,
  localOverrides: ResolveContext["localOverrides"],
): ResolveContext => ({
  remote: doc.config,
  localOverrides,
  env: {},
  envPrefix: "PKEY_CONFIG_",
});

describe("e2e: wire v3, worker handlers → JWS → client-core", () => {
  it("registration is closed for a licensed product; activation is the mint path", async () => {
    // Leg 1. djdl runs License, so its derived policy is `requires-license` (§6): the keyless
    // endpoint refuses everyone, and a licence key is the only way to become a device.
    const w = await bootstrap();
    expect(w.product.registration).toBe("requires-license");

    const refused = await handleRegister(
      mkReq("POST", { "x-polaris-device": DEVICE }),
      w.env,
      w.db,
      w.product,
      NOW,
      SERVICES,
    );
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: { code: "registration_closed" },
    });

    const { token } = await activateAndSync(w, w.key, DEVICE);
    expect(token).toMatch(/^plrst_[A-Za-z0-9_-]{43}$/);
  });

  it("activate → both documents → verify → the gate reports ok", async () => {
    // Leg 2. The two documents carry disjoint halves of what the fused v2 document carried.
    const w = await bootstrap({
      config: { "quality.losslessOnly": enforced(true) },
    });
    const { cache } = await activateAndSync(w, w.key, DEVICE);

    // The license document carries the grants, and only the grants (§2.1, D-20).
    const lic = await verifyLicenseDoc(
      cache.docs.license,
      verifyOpts(DEVICE, NOW),
    );
    expect(lic).not.toBeNull();
    expect(lic!.aud).toBe("djdl");
    expect(lic!.iss).toBe("plrs.im");
    expect(lic!.deviceId).toBe(DEVICE);
    expect(lic!.licenseId).toBe(w.licenseId);
    expect(lic!.issuedAt).toBe(NOW);
    expect(lic!.entitlements.polarisVpn).toEqual({
      state: "enforced",
      value: true,
      updatedAt: NOW,
    });

    // The config document carries the settings, and no licence fields (§2.2, D-08).
    const cfg = await verifyConfigDoc(
      cache.docs.config,
      verifyOpts(DEVICE, NOW),
    );
    expect(cfg).not.toBeNull();
    expect(cfg!.config["quality.losslessOnly"]).toEqual({
      state: "enforced",
      value: true,
      updatedAt: NOW,
    });
    expect(cfg).not.toHaveProperty("entitlements");

    const state = licenseState({
      licenseServiceEnabled: true,
      activation: "token",
      doc: lic,
      now: NOW,
    });
    expect(state.status).toBe("ok");
    expect(isUsable(state.status)).toBe(true);
  });

  it("the verifier rejects a document spliced to a different device (anti-replay)", async () => {
    const w = await bootstrap();
    const { cache } = await activateAndSync(w, w.key, DEVICE);
    // Same valid JWS, wrong device binding ⇒ neither document is applied.
    expect(
      await verifyLicenseDoc(cache.docs.license, verifyOpts("dev-OTHER", NOW)),
    ).toBeNull();
    expect(
      await verifyConfigDoc(cache.docs.config, verifyOpts("dev-OTHER", NOW)),
    ).toBeNull();
  });

  it("refuses to verify one document as the other (typ domain separation)", async () => {
    // The two documents share one signing key, so `typ` is the only thing between them (§2).
    const w = await bootstrap();
    const { cache } = await activateAndSync(w, w.key, DEVICE);
    expect(
      await verifyConfigDoc(cache.docs.license, verifyOpts(DEVICE, NOW)),
    ).toBeNull();
    expect(
      await verifyLicenseDoc(cache.docs.config, verifyOpts(DEVICE, NOW)),
    ).toBeNull();
  });

  it("ETag/304 is per document, so a settings change costs no licence round-trip", async () => {
    // Leg 3a. Independent tags are the §5 rule that makes the split worth having on the wire.
    const w = await bootstrap({
      config: { "quality.losslessOnly": enforced(true) },
    });
    const { token, cache } = await activateAndSync(w, w.key, DEVICE);
    expect(cache.etags.license).not.toBe(cache.etags.config);

    const conditional = (etag: string): Request =>
      mkReq("GET", {
        authorization: `Bearer ${token}`,
        "x-polaris-version": "1.2.3",
        "if-none-match": etag,
      });
    const status = async (
      which: "license" | "config",
      etag: string,
      now: number,
    ): Promise<number> => {
      const handler =
        which === "license" ? handleLicenseDocument : handleConfigDocument;
      const res = await handler(conditional(etag), w.env, w.db, w.product, now);
      return res.status;
    };

    // Unchanged content: both 304.
    //
    // KNOWN DIVERGENCE, deliberately not asserted around: the config document's catalog-default
    // layer stamps `updatedAt: now` (`core/payload.ts` `catalogDefaultPayload`), so for a
    // product whose catalog declares defaults the config tag also moves with the clock. That
    // makes §5's conditional refetch weaker than it reads for such products. It is pre-existing
    // and orthogonal to the document split, so this suite pins the property that IS true —
    // per-document independence — at a fixed instant rather than pretending the other holds.
    expect(await status("license", cache.etags.license, NOW)).toBe(304);
    expect(await status("config", cache.etags.config, NOW)).toBe(304);

    // A config-only change moves the CONFIG tag and leaves the licence tag alone…
    await w.db.run(
      "UPDATE licenses SET overrides_json = ? WHERE product = ? AND id = ?",
      JSON.stringify({
        config: { "quality.losslessOnly": enforced(false) },
        secrets: {},
        entitlements: { polarisVpn: enforced(true) },
      }),
      "djdl",
      w.licenseId,
    );
    expect(await status("config", cache.etags.config, NOW)).toBe(200);
    expect(await status("license", cache.etags.license, NOW)).toBe(304);

    // …and an entitlement change moves the LICENCE tag while the (now-current) config tag
    // stays put. That symmetry is the whole point of splitting the documents on the wire.
    const currentConfigEtag = (
      await handleConfigDocument(
        mkReq("GET", { authorization: `Bearer ${token}` }),
        w.env,
        w.db,
        w.product,
        NOW,
      )
    ).headers.get("etag")!;
    await w.db.run(
      "UPDATE licenses SET overrides_json = ? WHERE product = ? AND id = ?",
      JSON.stringify({
        config: { "quality.losslessOnly": enforced(false) },
        secrets: {},
        entitlements: { polarisVpn: enforced(false) },
      }),
      "djdl",
      w.licenseId,
    );
    expect(await status("license", cache.etags.license, NOW)).toBe(200);
    expect(await status("config", currentConfigEtag, NOW)).toBe(304);
  });

  it("offline reload: re-verifies from cache and walks ok → grace → expired", async () => {
    // Leg 3b. Nothing is fetched here. The client re-verifies the JWSs it stored, folds the
    // floor over the whole artifact set, and gates against it.
    const w = await bootstrap();
    const { cache } = await activateAndSync(w, w.key, DEVICE);

    const gateAt = async (systemNow: number) => {
      const r = await reload(cache, DEVICE, systemNow);
      expect(r.license).not.toBeNull();
      expect(r.config).not.toBeNull();
      return {
        ...r,
        state: licenseState({
          licenseServiceEnabled: true,
          activation: "token",
          doc: r.license,
          now: r.now,
          highWaterMark: r.floor,
        }),
      };
    };

    const fresh = await gateAt(NOW);
    expect(fresh.state.status).toBe("ok");
    expect(isUsable(fresh.state)).toBe(true);
    // Every artifact was minted at NOW, so the floor is exactly NOW.
    expect(fresh.floor).toBe(NOW);

    // Past the short `expiresAt`, inside the long `graceUntil`: keeps running. This is the leg
    // that would be deleted outright if the reload path asserted freshness.
    const doc = fresh.license!;
    const inGrace = doc.expiresAt + 60;
    expect(inGrace).toBeLessThan(doc.graceUntil);
    expect((await gateAt(inGrace)).state.status).toBe("grace");

    // Past `graceUntil`: the cached document no longer suffices.
    const past = doc.graceUntil + 60;
    const lapsed = await gateAt(past);
    expect(lapsed.state.status).toBe("expired");
    expect(isUsable(lapsed.state)).toBe(false);
  });

  it("a corrupted cached document is treated as ABSENT, never as partial state", async () => {
    // §4.1's fail-closed rule: a failed license doc ⇒ `needs-activation`, and the config half
    // of the same record is unaffected — the slices are verified independently.
    const w = await bootstrap();
    const { cache } = await activateAndSync(w, w.key, DEVICE);
    const tampered: Cache = {
      ...cache,
      docs: {
        ...cache.docs,
        license: cache.docs.license.slice(0, -4) + "AAAA",
      },
    };
    const r = await reload(tampered, DEVICE, NOW);
    expect(r.license).toBeNull();
    expect(r.config).not.toBeNull();
    expect(
      licenseState({
        licenseServiceEnabled: true,
        activation: "token",
        doc: r.license,
        now: r.now,
      }).status,
    ).toBe("needs-activation");
  });

  it("the clock floor: winding the system clock back does not restore a lapsed licence", async () => {
    // Leg 3c. §4.2's whole point, in the shape it actually occurs: the licence document stays
    // cached while CORE keeps refreshing trust on its own schedule, so the signed clock runs
    // past the document's grace. The user then winds the system clock back to activation day.
    const w = await bootstrap();
    const first = await activateAndSync(w, w.key, DEVICE);
    const doc = (await verifyLicenseDoc(
      first.cache.docs.license,
      verifyOpts(DEVICE, NOW),
    ))!;

    // Honest clock, nothing stale: the floor costs nothing.
    const honest = await reload(first.cache, DEVICE, NOW + 30);
    expect(honest.now).toBe(NOW + 30);

    // Trust refreshed well past the document's `graceUntil`; the documents are the ones the
    // client already had. This is the artifact set a long-running install holds.
    const afterGrace = doc.graceUntil + 3600;
    const refreshed = await sync(w, first.token, afterGrace);
    const stale: Cache = { ...first.cache, trustJws: refreshed.trustJws };

    // System clock wound back to activation day. The floor is the trust manifest's `issuedAt`,
    // which is exactly why trust refresh must not ride a document fetch: without it the floor
    // would be the document's own `issuedAt` and could never reach the end of its own grace.
    const rolledBack = await reload(stale, DEVICE, NOW);
    expect(rolledBack.floor).toBe(afterGrace);
    expect(rolledBack.now).toBe(afterGrace);

    const gated = (now: number, floor?: number) =>
      licenseState({
        licenseServiceEnabled: true,
        activation: "token",
        doc: rolledBack.license,
        now,
        ...(floor === undefined ? {} : { highWaterMark: floor }),
      }).status;

    // WITH the floor: the licence is over, whatever the machine believes the date is.
    expect(gated(rolledBack.now, rolledBack.floor)).toBe("expired");
    // WITHOUT it — the defective form — the same bytes read `ok`. That gap is the attack.
    expect(gated(NOW)).toBe("ok");
  });

  it("401 → exactly one token re-acquire → the retry succeeds", async () => {
    // Leg 4. §5's single-attempt rule, from the server's side: the exchange invalidates the old
    // credential, the stale one 401s everywhere, and it cannot be used to re-acquire either —
    // which is what stops a client looping on the "one retry".
    const w = await bootstrap();
    const { token: stale } = await activateAndSync(w, w.key, DEVICE);

    const rotated = await handleToken(
      mkReq("POST", {
        authorization: `Bearer ${stale}`,
        "x-polaris-device": DEVICE,
      }),
      w.env,
      w.db,
      w.product,
      NOW + 5,
    );
    expect(rotated.status).toBe(200);
    const { token: fresh } = (await rotated.json()) as { token: string };
    expect(fresh).not.toBe(stale);
    expect(fresh).toMatch(/^plrst_/);

    // The stale credential now 401s…
    expect(
      (
        await handleLicenseDocument(
          mkReq("GET", { authorization: `Bearer ${stale}` }),
          w.env,
          w.db,
          w.product,
          NOW + 6,
        )
      ).status,
    ).toBe(401);

    // …including on the re-acquire itself.
    expect(
      (
        await handleToken(
          mkReq("POST", {
            authorization: `Bearer ${stale}`,
            "x-polaris-device": DEVICE,
          }),
          w.env,
          w.db,
          w.product,
          NOW + 6,
        )
      ).status,
    ).toBe(401);

    // The retry with the fresh token succeeds, and the document verifies as normal.
    const retried = await handleLicenseDocument(
      mkReq("GET", { authorization: `Bearer ${fresh}` }),
      w.env,
      w.db,
      w.product,
      NOW + 7,
    );
    expect(retried.status).toBe(200);
    expect(
      await verifyLicenseDoc(await retried.text(), verifyOpts(DEVICE, NOW + 7)),
    ).not.toBeNull();
  });

  it("deauthorize wipes the device: every surface it held stops answering", async () => {
    // Leg 5. One call, and the credential is dead everywhere — both documents, telemetry, and
    // the token exchange that would otherwise mint a replacement.
    const w = await bootstrap();
    const { token } = await activateAndSync(w, w.key, DEVICE);

    const gone = await handleDeauthorize(
      mkReq("POST", { authorization: `Bearer ${token}` }),
      w.env,
      w.db,
      w.product,
    );
    expect(gone.status).toBe(200);

    const auth = { authorization: `Bearer ${token}` };
    expect(
      (
        await handleLicenseDocument(
          mkReq("GET", auth),
          w.env,
          w.db,
          w.product,
          NOW + 10,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await handleConfigDocument(
          mkReq("GET", auth),
          w.env,
          w.db,
          w.product,
          NOW + 10,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await handleReport(
          mkReq("POST", auth, {}),
          w.env,
          w.db,
          w.product,
          NOW + 10,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await handleToken(
          mkReq("POST", { ...auth, "x-polaris-device": DEVICE }),
          w.env,
          w.db,
          w.product,
          NOW + 10,
        )
      ).status,
    ).toBe(401);

    // The device is retired in D1, and the fingerprint/facts it carried are purged with it.
    expect(
      (
        await w.db.first<{ status: string }>(
          "SELECT status FROM devices WHERE product = ? AND device_id = ?",
          "djdl",
          DEVICE,
        )
      )?.status,
    ).toBe("deauthorized");
  });

  it("a config-only product completes the whole flow with no licence anywhere (D-08)", async () => {
    // Leg 6. The wire-level proof of service independence: register (no key), fetch a config
    // document, and gate `not-applicable` — usable, with no licence and no licence document.
    const w = await bootstrap({
      services: CONFIG_ONLY,
      config: { "quality.losslessOnly": enforced(true) },
    });
    expect(w.product.registration).toBe("open");

    const res = await handleRegister(
      mkReq("POST", { "x-polaris-device": DEVICE }),
      w.env,
      w.db,
      w.product,
      NOW,
      SERVICES,
    );
    expect(res.status).toBe(200);
    const { token, deviceId } = (await res.json()) as {
      token: string;
      deviceId: string;
    };
    expect(deviceId).toBe(DEVICE);
    expect(token).toMatch(/^plrst_/);

    const cfgRes = await handleConfigDocument(
      mkReq("GET", { authorization: `Bearer ${token}` }),
      w.env,
      w.db,
      w.product,
      NOW,
    );
    expect(cfgRes.status).toBe(200);
    const cfg = await verifyConfigDoc(
      await cfgRes.text(),
      verifyOpts(DEVICE, NOW),
    );
    expect(cfg).not.toBeNull();
    expect(cfg!.deviceId).toBe(DEVICE);
    expect(cfg).not.toHaveProperty("licenseId");
    expect(cfg).not.toHaveProperty("entitlements");

    // No licence service ⇒ `not-applicable`, and usable regardless of any document.
    const state = licenseState({
      licenseServiceEnabled: false,
      activation: null,
      doc: null,
      now: NOW,
    });
    expect(state.status).toBe("not-applicable");
    expect(isUsable(state.status)).toBe(true);

    // The licence-gated half of the wire stays shut for it: no licence row, no grant.
    expect(
      (
        await handleLicenseDocument(
          mkReq("GET", { authorization: `Bearer ${token}` }),
          w.env,
          w.db,
          w.product,
          NOW,
        )
      ).status,
    ).toBe(401);
  });

  it("ENFORCED override: the resolver returns the server value even against a local override", async () => {
    // Admin enforces quality.losslessOnly=true on the license; the config doc carries it as
    // `enforced`.
    const w = await bootstrap({
      config: { "quality.losslessOnly": enforced(true) },
    });
    const { cache } = await activateAndSync(w, w.key, DEVICE);
    const cfg = (await verifyConfigDoc(
      cache.docs.config,
      verifyOpts(DEVICE, NOW),
    )) as ConfigDoc;
    expect(cfg.config["quality.losslessOnly"]?.state).toBe("enforced");

    // Given a CONFLICTING local override, the client must still surface the server value for
    // the enforced key — an enforced entry is not overridable.
    const conflicting = ctx(cfg, { "quality.losslessOnly": false });
    expect(resolveValue(conflicting, "quality.losslessOnly")).toBe(true);
    expect(resolveSource(conflicting, "quality.losslessOnly")).toBe("enforced");

    // A `default`-state key, by contrast, IS overridable (proves the override path is wired
    // and only the `enforced` state is locking the value above).
    const w2 = await bootstrap({
      config: {
        "quality.floor": { state: "default", value: "any", updatedAt: NOW },
      },
    });
    const second = await activateAndSync(w2, w2.key, DEVICE);
    const cfg2 = (await verifyConfigDoc(
      second.cache.docs.config,
      verifyOpts(DEVICE, NOW),
    )) as ConfigDoc;
    expect(
      resolveValue(ctx(cfg2, { "quality.floor": "flac" }), "quality.floor"),
    ).toBe("flac");
  });
});
