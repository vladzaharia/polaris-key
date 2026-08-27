// True end-to-end flow over the REAL worker handlers (makeTestDb + KvMock) feeding the REAL
// reference client (`@plrs/client-core`). Nothing here re-implements server or client logic:
// the documents are minted by handleActivate → handleLicenseDocument / handleConfigDocument,
// verified by client-core's frozen JWS + claim path, gated by `licenseState`, and read back
// through client-core's layered config resolver. This is the cross-package contract test the
// per-package unit suites can't cover alone.
//
// ── WHY client-core AND NOT @plrs/node ──────────────────────────────────────────────────────
//
// This file used to drive `@plrs/node`'s `PolarisKeyClient` over the fused v2 document. Wire v3
// splits that document in two, so `@plrs/node` — whose verifier demands
// `typ: "pkey-config+jws"`, whose expected `iss` is `key.plrs.im`, and whose cache record holds
// a single `configJws` — cannot consume what the worker now signs. Re-shaping the Node SDK is
// P4; re-baselining this suite onto the complete v3 client flow is T1.7. What this file does
// NOW is keep the same assertions running against the same worker code, expressed over the
// reference client that already speaks v3. Every original assertion has an heir below.

import { describe, expect, it } from "vitest";
import {
  isUsable,
  licenseState,
  resolveSource,
  resolveValue,
  verifyConfigDoc,
  verifyLicenseDoc,
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
import { handleActivate } from "../src/services/license/activation.js";
import { handleLicenseDocument } from "../src/services/license/document.js";
import { handleConfigDocument } from "../src/services/config/document.js";
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
  // Seed with the REAL djdl catalog so config keys survive the pre-sign prune.
  await seedProduct(db, "djdl", { catalog: DJDL_CATALOG });
  const product = (await loadProduct(env, db, "djdl"))!;
  expect(product).toBeTruthy();
  const { key, licenseId } = await seedLicenseWithKey(db, "djdl", {
    entitlements: { polarisVpn: enforced(true) },
    config: opts.config,
  });
  return { db, kv, env, product, key, licenseId };
}

/** Drive activate (key→token) then BOTH documents through the real handlers. */
async function activateAndFetch(
  w: World,
  key: string,
  device: string,
  now = NOW,
): Promise<{ licenseJws: string; configJws: string; etags: [string, string] }> {
  const activateRes = await handleActivate(
    mkReq("POST", { authorization: `Bearer ${key}`, "x-pkey-device": device }),
    w.env,
    w.db,
    w.product,
    now,
  );
  expect(activateRes.status).toBe(200);
  const { token } = (await activateRes.json()) as { token: string };

  const req = (): Request =>
    mkReq("GET", {
      authorization: `Bearer ${token}`,
      "x-pkey-version": "1.2.3",
    });
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
    licenseJws: await licRes.text(),
    configJws: await cfgRes.text(),
    etags: [licRes.headers.get("etag")!, cfgRes.headers.get("etag")!],
  };
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

describe("e2e: worker handlers → JWS → client-core gate", () => {
  it("activate → both documents → verify → licenseState reports ok", async () => {
    const w = await bootstrap({
      config: { "quality.losslessOnly": enforced(true) },
    });
    const { licenseJws, configJws } = await activateAndFetch(w, w.key, "dev-1");

    // 1) The license document carries the grants, and only the grants (§2.1, D-20).
    const lic = await verifyLicenseDoc(licenseJws, verifyOpts("dev-1", NOW));
    expect(lic).not.toBeNull();
    expect(lic!.aud).toBe("djdl");
    expect(lic!.iss).toBe("plrs.im");
    expect(lic!.deviceId).toBe("dev-1");
    expect(lic!.licenseId).toBe(w.licenseId);
    expect(lic!.issuedAt).toBe(NOW);
    expect(lic!.entitlements.polarisVpn).toEqual({
      state: "enforced",
      value: true,
      updatedAt: NOW,
    });

    // 2) The config document carries the settings, and no licence fields (§2.2, D-08).
    const cfg = await verifyConfigDoc(configJws, verifyOpts("dev-1", NOW));
    expect(cfg).not.toBeNull();
    expect(cfg!.config["quality.losslessOnly"]).toEqual({
      state: "enforced",
      value: true,
      updatedAt: NOW,
    });
    expect(cfg).not.toHaveProperty("entitlements");

    // 3) The real gate reports `ok` (fresh doc, activated, not blocked).
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
    const { licenseJws, configJws } = await activateAndFetch(w, w.key, "dev-1");
    // Same valid JWS, wrong device binding ⇒ neither document is applied.
    expect(
      await verifyLicenseDoc(licenseJws, verifyOpts("dev-OTHER", NOW)),
    ).toBeNull();
    expect(
      await verifyConfigDoc(configJws, verifyOpts("dev-OTHER", NOW)),
    ).toBeNull();
  });

  it("refuses to verify one document as the other (typ domain separation)", async () => {
    // The two documents share one signing key, so `typ` is the only thing between them (§2).
    const w = await bootstrap();
    const { licenseJws, configJws } = await activateAndFetch(w, w.key, "dev-1");
    expect(
      await verifyConfigDoc(licenseJws, verifyOpts("dev-1", NOW)),
    ).toBeNull();
    expect(
      await verifyLicenseDoc(configJws, verifyOpts("dev-1", NOW)),
    ).toBeNull();
  });

  it("offline → online transition: cached doc goes ok → grace → expired, then re-fetch to ok", async () => {
    const w = await bootstrap();
    const { licenseJws } = await activateAndFetch(w, w.key, "dev-1");
    const doc = await verifyLicenseDoc(licenseJws, verifyOpts("dev-1", NOW));
    expect(doc).not.toBeNull();

    const gate = (now: number, d: LicenseDoc | null = doc) =>
      licenseState({
        licenseServiceEnabled: true,
        activation: "token",
        doc: d,
        now,
      });

    // Offline and fresh: `ok`.
    expect(gate(NOW).status).toBe("ok");
    expect(isUsable(gate(NOW))).toBe(true);

    // Offline, past the short `expiresAt` but inside the long `graceUntil`: keeps running.
    const inGrace = doc!.expiresAt + 60;
    expect(inGrace).toBeLessThan(doc!.graceUntil);
    expect(gate(inGrace).status).toBe("grace");
    expect(isUsable(gate(inGrace))).toBe(true);

    // Offline, past `graceUntil`: the cached document no longer suffices.
    const expired = doc!.graceUntil + 60;
    expect(gate(expired).status).toBe("expired");
    expect(isUsable(gate(expired))).toBe(false);

    // Back online at that later time: a freshly-minted document re-establishes `ok` with a
    // strictly-newer issuedAt, which the per-type anti-replay floor accepts (§3).
    const again = await activateAndFetch(w, w.key, "dev-1", expired);
    const doc2 = await verifyLicenseDoc(again.licenseJws, {
      ...verifyOpts("dev-1", expired),
      lastAcceptedIssuedAt: doc!.issuedAt,
    });
    expect(doc2).not.toBeNull();
    expect(doc2!.issuedAt).toBeGreaterThan(doc!.issuedAt);
    expect(gate(expired, doc2).status).toBe("ok");
  });

  it("ENFORCED override: the resolver returns the server value even against a local override", async () => {
    // Admin enforces quality.losslessOnly=true on the license; the config doc carries it as
    // `enforced`.
    const w = await bootstrap({
      config: { "quality.losslessOnly": enforced(true) },
    });
    const { configJws } = await activateAndFetch(w, w.key, "dev-1");
    const cfg = (await verifyConfigDoc(
      configJws,
      verifyOpts("dev-1", NOW),
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
    const second = await activateAndFetch(w2, w2.key, "dev-1");
    const cfg2 = (await verifyConfigDoc(
      second.configJws,
      verifyOpts("dev-1", NOW),
    )) as ConfigDoc;
    expect(
      resolveValue(ctx(cfg2, { "quality.floor": "flac" }), "quality.floor"),
    ).toBe("flac");
  });
});
