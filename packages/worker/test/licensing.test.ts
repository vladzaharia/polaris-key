import { beforeEach, describe, expect, it } from "vitest";
import { verifyJws } from "@polaris-key/jws";
import { verifyConfigDoc, verifyLicenseDoc } from "@polaris-key/client-core";
import type { LicenseDoc } from "@polaris-key/protocol/license";
import type { ConfigDoc } from "@polaris-key/protocol/config";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import {
  UNKNOWN_DEVICE_TOKEN,
  makeEnv,
  mkReq,
  NOW,
  seedLicenseWithKey,
  seedProduct,
  seedTier,
  TEST_KID,
  TEST_PUB,
} from "./seed.js";
import { loadProduct, type Product } from "../src/core/products.js";
import {
  handleActivate,
  handleToken,
} from "../src/services/license/activation.js";
import { handleLicenseDocument } from "../src/services/license/document.js";
import { handleConfigDocument } from "../src/services/config/document.js";
import { handleDevices } from "../src/core/devices.js";
import type { Env } from "../src/env.js";
import type { SqliteDb } from "../src/db/sqlite.js";
import { hashKey } from "../src/crypto.js";
import { getTokenRecord } from "../src/kv.js";
import { setLicenseProfiles } from "../src/repo.js";

const TRUST = { [TEST_KID]: TEST_PUB };

async function activate(
  env: Env,
  db: SqliteDb,
  product: Product,
  key: string,
  device: string,
): Promise<string> {
  const res = await handleActivate(
    mkReq("POST", {
      authorization: `Bearer ${key}`,
      "x-pkey-device": device,
    }),
    env,
    db,
    product,
    NOW,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { token: string };
  return body.token;
}

describe("licensing", () => {
  let db: SqliteDb;
  let kv: KvMock;
  let env: Env;
  let product: Product;

  beforeEach(async () => {
    db = makeTestDb();
    kv = new KvMock();
    env = makeEnv(kv, ["djdl"]);
    await seedProduct(db, "djdl");
    product = (await loadProduct(env, db, "djdl"))!;
    expect(product).toBeTruthy();
  });

  // The two documents are asserted through `@polaris-key/client-core`'s verifiers rather than through
  // a hand-written shape check. That is the whole point of the exercise: client-core is the
  // reference implementation every SDK's verifier is ported from, so a document it accepts is a
  // document the wire contract accepts, and a field the worker drifts on fails here rather than
  // in a language runner three phases later.
  it("activate → license/document returns a v3 license doc the reference verifier accepts", async () => {
    const { licenseId, key } = await seedLicenseWithKey(db, "djdl", {
      entitlements: {
        polarisVpn: { state: "enforced", value: true, updatedAt: NOW },
      },
    });
    const token = await activate(env, db, product, key, "dev-1");

    const res = await handleLicenseDocument(
      mkReq("GET", {
        authorization: `Bearer ${token}`,
        "x-pkey-version": "1.2.3",
      }),
      env,
      db,
      product,
      NOW,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/jwt");
    const jws = await res.text();

    // The frozen envelope: signed by the product's kid, and stamped `pkey-license+jws` so it
    // cannot be replayed where a config document is expected.
    const raw = await verifyJws<LicenseDoc>(jws, TRUST);
    expect(raw).not.toBeNull();
    expect(raw!.kid).toBe(TEST_KID);
    expect(
      JSON.parse(
        atob(jws.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/")),
      ),
    ).toMatchObject({
      alg: "EdDSA",
      typ: "pkey-license+jws",
      kid: TEST_KID,
    });

    const doc = await verifyLicenseDoc(jws, {
      trust: TRUST,
      expectedAud: "djdl",
      deviceId: "dev-1",
      now: NOW,
    });
    expect(doc).not.toBeNull();
    expect(doc!.iss).toBe("key.plrs.im"); // host-neutral in v3 (D-09), not `key.plrs.im`
    expect(doc!.licenseId).toBe(licenseId);
    expect(doc!.issuedAt).toBe(NOW);
    expect(doc!.expiresAt).toBe(NOW + 3600);
    // graceUntil = issuedAt + maxOfflineDays * 86400; the seeded product default is 30 days.
    expect(doc!.graceUntil).toBe(NOW + 30 * 86_400);
    expect(doc!.profile?.email).toBe("ada@example.com");
    // Grants — and ONLY grants (D-20).
    expect(doc!.entitlements.polarisVpn?.value).toBe(true);
    expect(doc).not.toHaveProperty("config");
    expect(doc).not.toHaveProperty("secrets");
    expect(doc).not.toHaveProperty("payload");
  });

  it("config/document returns a v3 config doc carrying settings and no license fields", async () => {
    const { key } = await seedLicenseWithKey(db, "djdl", {
      config: {
        "app.theme": { state: "enforced", value: "dark", updatedAt: NOW },
      },
      entitlements: {
        polarisVpn: { state: "enforced", value: true, updatedAt: NOW },
      },
    });
    // A catalog that declares the key, so it survives the pre-sign prune.
    await db.run("DELETE FROM product_schema WHERE product = ?", "djdl");
    await db.run(
      "INSERT INTO product_schema (product, catalog_version, catalog_json, active, created_at) VALUES (?,?,?,?,?)",
      "djdl",
      7,
      JSON.stringify({
        schemaVersion: 7,
        entries: [
          {
            key: "app.theme",
            kind: "config",
            category: "app",
            label: "Theme",
            description: "",
            schema: { type: "string" },
            managementDefault: "default",
          },
        ],
      }),
      1,
      NOW,
    );
    product = (await loadProduct(env, db, "djdl"))!;
    const token = await activate(env, db, product, key, "dev-1");

    const res = await handleConfigDocument(
      mkReq("GET", { authorization: `Bearer ${token}` }),
      env,
      db,
      product,
      NOW,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/jwt");
    const jws = await res.text();
    expect(
      JSON.parse(
        atob(jws.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/")),
      ),
    ).toMatchObject({
      typ: "pkey-config+jws",
    });

    const doc = await verifyConfigDoc(jws, {
      trust: TRUST,
      expectedAud: "djdl",
      deviceId: "dev-1",
      now: NOW,
    });
    expect(doc).not.toBeNull();
    expect(doc!.iss).toBe("key.plrs.im");
    // The PRODUCT's catalog version, not the wire version.
    expect(doc!.schemaVersion).toBe(7);
    expect(doc!.config["app.theme"]).toEqual({
      state: "enforced",
      value: "dark",
      updatedAt: NOW,
    });
    expect(doc!.secrets).toEqual({});
    // §2.2 — no licence fields whatsoever, entitlements included.
    expect(doc).not.toHaveProperty("licenseId");
    expect(doc).not.toHaveProperty("profile");
    expect(doc).not.toHaveProperty("entitlements");
  });

  it("gives the two documents independent ETags", async () => {
    const { key } = await seedLicenseWithKey(db, "djdl");
    const token = await activate(env, db, product, key, "dev-1");
    const get = async (
      handler: typeof handleLicenseDocument,
    ): Promise<string> =>
      (
        await handler(
          mkReq("GET", { authorization: `Bearer ${token}` }),
          env,
          db,
          product,
          NOW,
        )
      ).headers.get("etag")!;

    const licenseTag = await get(handleLicenseDocument);
    const configTag = await get(handleConfigDocument);
    expect(licenseTag).toBeTruthy();
    expect(configTag).toBeTruthy();
    // §5 applies the ETag rule PER DOCUMENT: a licence change must not force a settings
    // re-download, which is only true if the two tags are computed over disjoint content.
    expect(licenseTag).not.toBe(configTag);
  });

  it("returns 304 when If-None-Match matches", async () => {
    const { key } = await seedLicenseWithKey(db, "djdl");
    const token = await activate(env, db, product, key, "dev-1");
    const first = await handleLicenseDocument(
      mkReq("GET", {
        authorization: `Bearer ${token}`,
        "x-pkey-version": "1.2.3",
      }),
      env,
      db,
      product,
      NOW,
    );
    const etag = first.headers.get("etag")!;
    expect(etag).toBeTruthy();
    const second = await handleLicenseDocument(
      mkReq("GET", {
        authorization: `Bearer ${token}`,
        "x-pkey-version": "1.2.3",
        "if-none-match": etag,
      }),
      env,
      db,
      product,
      NOW,
    );
    expect(second.status).toBe(304);
  });

  it("enforces the device limit", async () => {
    const { key } = await seedLicenseWithKey(db, "djdl", {
      entitlements: {
        deviceLimit: { state: "enforced", value: 1, updatedAt: NOW },
      },
    });
    await activate(env, db, product, key, "dev-1");
    const res = await handleActivate(
      mkReq("POST", {
        authorization: `Bearer ${key}`,
        "x-pkey-device": "dev-2",
      }),
      env,
      db,
      product,
      NOW,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; limit: number };
    expect(body.error).toBe("device_limit");
    expect(body.limit).toBe(1);
  });

  it("activate returns device-first limit errors and account metadata", async () => {
    const { key } = await seedLicenseWithKey(db, "djdl", {
      entitlements: {
        deviceLimit: { state: "enforced", value: 1, updatedAt: NOW },
      },
    });
    const first = await handleActivate(
      mkReq("POST", {
        authorization: `Bearer ${key}`,
        "x-pkey-device": "dev-1",
      }),
      env,
      db,
      product,
      NOW,
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      token: string;
      device: { id: string };
      license: { id: string };
    };
    expect(firstBody.device.id).toBe("dev-1");
    expect(firstBody.license.id).toBe("lic_djdl_1");

    const second = await handleActivate(
      mkReq("POST", {
        authorization: `Bearer ${key}`,
        "x-pkey-device": "dev-2",
      }),
      env,
      db,
      product,
      NOW,
    );
    expect(second.status).toBe(403);
    const body = (await second.json()) as {
      error: string;
      limit: number;
      deviceCount: number;
    };
    expect(body.error).toBe("device_limit");
    expect(body.limit).toBe(1);
    expect(body.deviceCount).toBe(1);
  });

  it("the devices endpoint exposes friendly self-service management", async () => {
    const { key } = await seedLicenseWithKey(db, "djdl");
    const token = await activate(env, db, product, key, "dev-1");

    // `GET /<p>/account` used to open this test by returning the licence plus the same device
    // list. Wire v3 removes it (§R1): its licence half is the license document and its device
    // half is exactly the `GET /devices` call below, so it was a third name for two answers.
    const current = await handleDevices(
      mkReq("GET", { authorization: `Bearer ${token}` }),
      env,
      db,
      product,
      NOW,
    );
    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject({
      currentDeviceId: "dev-1",
      devices: [expect.objectContaining({ id: "dev-1", current: true })],
    });

    const rename = await handleDevices(
      mkReq(
        "PATCH",
        {
          authorization: `Bearer ${token}`,
        },
        { label: "Studio Mac" },
      ),
      env,
      db,
      product,
      NOW,
      "dev-1",
    );
    expect(rename.status).toBe(200);
    expect(await rename.json()).toMatchObject({
      ok: true,
      device: { id: "dev-1", label: "Studio Mac" },
    });

    const list = await handleDevices(
      mkReq("GET", {
        authorization: `Bearer ${token}`,
      }),
      env,
      db,
      product,
      NOW,
    );
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      devices: [expect.objectContaining({ id: "dev-1", label: "Studio Mac" })],
    });

    // A device's own rename goes through PX-W13's label rule: no control character is ever
    // stored (a CLI that prints the label could otherwise be driven by terminal escapes).
    const hostile = await handleDevices(
      mkReq(
        "PATCH",
        { authorization: `Bearer ${token}` },
        { label: "Lap\u001b]52;c;ZXZpbA==\u0007top\u001b[2J\u009b  Pro" },
      ),
      env,
      db,
      product,
      NOW,
      "dev-1",
    );
    expect(hostile.status).toBe(200);
    const hostileLabel = (
      (await hostile.json()) as { device: { label: string } }
    ).device.label;
    expect(hostileLabel).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    const stored = await db.first<{ label: string | null }>(
      "SELECT label FROM devices WHERE product = ? AND device_id = ?",
      product.slug,
      "dev-1",
    );
    expect(stored?.label).toBe(hostileLabel);
    expect([...(stored?.label ?? "")].length).toBeLessThanOrEqual(64);

    const remove = await handleDevices(
      mkReq("DELETE", {
        authorization: `Bearer ${token}`,
      }),
      env,
      db,
      product,
      NOW,
      "dev-1",
    );
    expect(remove.status).toBe(200);

    const rejected = await handleLicenseDocument(
      mkReq("GET", {
        authorization: `Bearer ${token}`,
        "x-pkey-version": "1.2.3",
      }),
      env,
      db,
      product,
      NOW,
    );
    expect(rejected.status).toBe(401);
  });

  it("re-activating the same device does not consume another device slot", async () => {
    const { key } = await seedLicenseWithKey(db, "djdl", {
      entitlements: {
        deviceLimit: { state: "enforced", value: 1, updatedAt: NOW },
      },
    });
    await activate(env, db, product, key, "dev-1");
    const again = await handleActivate(
      mkReq("POST", {
        authorization: `Bearer ${key}`,
        "x-pkey-device": "dev-1",
      }),
      env,
      db,
      product,
      NOW,
    );
    expect(again.status).toBe(200);
  });

  it("blocks a build below app.minVersion with allowedRange", async () => {
    const { key } = await seedLicenseWithKey(db, "djdl", {
      entitlements: {
        "app.minVersion": { state: "enforced", value: "2.0.0", updatedAt: NOW },
      },
    });
    const token = await activate(env, db, product, key, "dev-1");
    const res = await handleLicenseDocument(
      mkReq("GET", {
        authorization: `Bearer ${token}`,
        "x-pkey-version": "1.0.0",
      }),
      env,
      db,
      product,
      NOW,
    );
    expect(res.status).toBe(403);
    // §5 / R4: the nested v3 error body, with `allowedRange` beside it rather than inside it.
    // `code` collapses both version outcomes into `version_blocked`; `reason` keeps the
    // distinction a client needs to word the message.
    expect(await res.json()).toEqual({
      error: { code: "version_blocked", reason: "version-too-old" },
      allowedRange: { min: "2.0.0", max: "99.0.0" },
    });
  });

  it("rejects an unknown token", async () => {
    const res = await handleLicenseDocument(
      mkReq("GET", {
        authorization: `Bearer ${UNKNOWN_DEVICE_TOKEN}`,
        "x-pkey-version": "1.2.3",
      }),
      env,
      db,
      product,
      NOW,
    );
    expect(res.status).toBe(401);
  });

  it("rejects a stale KV token when the device row points at a different token hash", async () => {
    const { key } = await seedLicenseWithKey(db, "djdl");
    const token = await activate(env, db, product, key, "dev-1");
    await db.run(
      "UPDATE devices SET token_hash = ? WHERE product = ? AND device_id = ?",
      "different-hash",
      "djdl",
      "dev-1",
    );

    const res = await handleLicenseDocument(
      mkReq("GET", {
        authorization: `Bearer ${token}`,
        "x-pkey-version": "1.2.3",
      }),
      env,
      db,
      product,
      NOW,
    );
    expect(res.status).toBe(401);
  });

  it("builds config from catalog defaults plus ordered license profiles", async () => {
    await db.run("DELETE FROM product_schema WHERE product = ?", "djdl");
    await db.run(
      "INSERT INTO product_schema (product, catalog_version, catalog_json, active, created_at) VALUES (?,?,?,?,?)",
      "djdl",
      2,
      JSON.stringify({
        schemaVersion: 2,
        entries: [
          {
            key: "app.theme",
            kind: "config",
            category: "app",
            label: "Theme",
            description: "",
            schema: { type: "string" },
            default: "system",
            managementDefault: "default",
          },
          {
            key: "app.region",
            kind: "config",
            category: "app",
            label: "Region",
            description: "",
            schema: { type: "string" },
            default: "us",
            managementDefault: "default",
          },
        ],
      }),
      1,
      NOW,
    );
    product = (await loadProduct(env, db, "djdl"))!;
    await db.run(
      "INSERT INTO profiles (product, id, name, description, payload_json, modified_by, modified_at) VALUES (?,?,?,?,?,?,?)",
      "djdl",
      "base",
      "Base",
      null,
      JSON.stringify({
        config: {
          "app.theme": { state: "default", value: "light", updatedAt: NOW },
        },
        secrets: {},
        entitlements: {},
      }),
      null,
      NOW,
    );
    await db.run(
      "INSERT INTO profiles (product, id, name, description, payload_json, modified_by, modified_at) VALUES (?,?,?,?,?,?,?)",
      "djdl",
      "override",
      "Override",
      null,
      JSON.stringify({
        config: {
          "app.theme": { state: "default", value: "dark", updatedAt: NOW + 1 },
        },
        secrets: {},
        entitlements: {},
      }),
      null,
      NOW,
    );
    const { licenseId, key } = await seedLicenseWithKey(db, "djdl");
    await setLicenseProfiles(db, "djdl", licenseId, ["base", "override"]);
    const token = await activate(env, db, product, key, "dev-1");

    const res = await handleLicenseDocument(
      mkReq("GET", {
        authorization: `Bearer ${token}`,
        "x-pkey-version": "1.2.3",
      }),
      env,
      db,
      product,
      NOW,
    );
    expect(res.status).toBe(200);
    // Config values ride the CONFIG document now; the license document above only proves the
    // same token reaches both.
    const cfg = await handleConfigDocument(
      mkReq("GET", { authorization: `Bearer ${token}` }),
      env,
      db,
      product,
      NOW,
    );
    const doc = await verifyConfigDoc(await cfg.text(), {
      trust: TRUST,
      expectedAud: "djdl",
      deviceId: "dev-1",
      now: NOW,
    });
    expect(doc!.config["app.theme"]?.value).toBe("dark");
    expect(doc!.config["app.region"]?.value).toBe("us");
  });

  it("requires the current bearer token to replace a token", async () => {
    const { key } = await seedLicenseWithKey(db, "djdl");
    await activate(env, db, product, key, "dev-1");

    const missing = await handleToken(
      mkReq("POST", { "x-pkey-device": "dev-1" }),
      env,
      db,
      product,
      NOW,
    );
    expect(missing.status).toBe(401);

    const unknown = await handleToken(
      mkReq("POST", {
        authorization: `Bearer ${UNKNOWN_DEVICE_TOKEN}`,
        "x-pkey-device": "dev-1",
      }),
      env,
      db,
      product,
      NOW,
    );
    expect(unknown.status).toBe(401);
  });

  it("replaces a token only when the bearer and device binding match", async () => {
    const { key } = await seedLicenseWithKey(db, "djdl");
    const oldToken = await activate(env, db, product, key, "dev-1");
    const oldHash = await hashKey(oldToken, env.KEY_HASH_PEPPER);
    expect(await getTokenRecord(env, "djdl", oldHash)).not.toBeNull();

    const res = await handleToken(
      mkReq("POST", {
        authorization: `Bearer ${oldToken}`,
        "x-pkey-device": "dev-1",
      }),
      env,
      db,
      product,
      NOW + 10,
    );
    expect(res.status).toBe(200);
    const { token: newToken } = (await res.json()) as { token: string };
    expect(newToken).not.toBe(oldToken);

    expect(await getTokenRecord(env, "djdl", oldHash)).toBeNull();
    const newHash = await hashKey(newToken, env.KEY_HASH_PEPPER);
    expect(await getTokenRecord(env, "djdl", newHash)).toMatchObject({
      product: "djdl",
      deviceId: "dev-1",
      licenseId: "lic_djdl_1",
    });

    const oldConfig = await handleLicenseDocument(
      mkReq("GET", {
        authorization: `Bearer ${oldToken}`,
        "x-pkey-version": "1.2.3",
      }),
      env,
      db,
      product,
      NOW + 10,
    );
    expect(oldConfig.status).toBe(401);

    const newConfig = await handleLicenseDocument(
      mkReq("GET", {
        authorization: `Bearer ${newToken}`,
        "x-pkey-version": "1.2.3",
      }),
      env,
      db,
      product,
      NOW + 10,
    );
    expect(newConfig.status).toBe(200);
  });

  it("rejects token replacement when the bearer is bound to another device", async () => {
    const { key } = await seedLicenseWithKey(db, "djdl");
    const token = await activate(env, db, product, key, "dev-1");

    const res = await handleToken(
      mkReq("POST", {
        authorization: `Bearer ${token}`,
        "x-pkey-device": "dev-2",
      }),
      env,
      db,
      product,
      NOW,
    );
    expect(res.status).toBe(401);

    const stillValid = await handleLicenseDocument(
      mkReq("GET", {
        authorization: `Bearer ${token}`,
        "x-pkey-version": "1.2.3",
      }),
      env,
      db,
      product,
      NOW,
    );
    expect(stillValid.status).toBe(200);
  });

  // ── Admin-assignable upgrade channels + version windows (injected as enforced entitlements) ──

  it("admin-granted license channels let an otherwise-blocked staging build through", async () => {
    // A staging build (signalled via the channel header, real version so the window passes) is
    // blocked with no channel entitlement. With admin channels=["staging"] it passes the gate.
    const blocked = await seedLicenseWithKey(db, "djdl");
    const blockedToken = await activate(
      env,
      db,
      product,
      blocked.key,
      "dev-block",
    );
    const blockedRes = await handleLicenseDocument(
      mkReq("GET", {
        authorization: `Bearer ${blockedToken}`,
        "x-pkey-version": "1.0.0",
        "x-pkey-channel": "staging",
      }),
      env,
      db,
      product,
      NOW,
    );
    expect(blockedRes.status).toBe(403);
    expect(await blockedRes.json()).toMatchObject({
      error: { code: "channel_not_allowed", reason: "channel-not-entitled" },
    });

    // A second license with the admin channel policy granted.
    const granted = await seedLicenseWithKey(db, "djdl", {
      id: "lic_djdl_granted",
      channels: ["staging"],
    });
    const grantedToken = await activate(
      env,
      db,
      product,
      granted.key,
      "dev-ok",
    );
    const okRes = await handleLicenseDocument(
      mkReq("GET", {
        authorization: `Bearer ${grantedToken}`,
        "x-pkey-version": "1.0.0",
        "x-pkey-channel": "staging",
      }),
      env,
      db,
      product,
      NOW,
    );
    expect(okRes.status).toBe(200);
  });

  // ── One channel vocabulary (P0-04, WIRE-CONTRACT-V3 §5.1) ──

  async function docWithChannel(
    id: string,
    channels: string[],
    header: string,
  ): Promise<Response> {
    const { key } = await seedLicenseWithKey(db, "djdl", { id, channels });
    const token = await activate(env, db, product, key, `dev-${id}`);
    return handleLicenseDocument(
      mkReq("GET", {
        authorization: `Bearer ${token}`,
        "x-pkey-version": "1.0.0",
        "x-pkey-channel": header,
      }),
      env,
      db,
      product,
      NOW,
    );
  }

  it("X-PKey-Channel: beta — 200 with [stable, beta], 403 with [stable], 200 with [stable, staging]", async () => {
    expect(
      (await docWithChannel("lic_beta", ["stable", "beta"], "beta")).status,
    ).toBe(200);

    const refused = await docWithChannel("lic_stable", ["stable"], "beta");
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({
      error: { code: "channel_not_allowed", reason: "channel-not-entitled" },
    });

    // A legacy `staging` grant covers `beta` (§5.1 rule 4).
    expect(
      (await docWithChannel("lic_staging", ["stable", "staging"], "beta"))
        .status,
    ).toBe(200);
  });

  it("X-PKey-Channel: staging is the beta channel; a malformed header is refused", async () => {
    expect(
      (await docWithChannel("lic_beta2", ["stable", "beta"], "staging")).status,
    ).toBe(200);

    const malformed = await docWithChannel(
      "lic_all",
      ["stable", "staging", "beta"],
      "STAGING",
    );
    expect(malformed.status).toBe(403);
    expect(await malformed.json()).toMatchObject({
      error: { code: "channel_not_allowed", reason: "channel-not-entitled" },
    });
  });

  it("an admin maxVersion narrower than the product compat_max blocks a too-new build", async () => {
    // Product compat window is 0.0.0..99.0.0; admin caps at 2.0.0 (tighter wins).
    const { key } = await seedLicenseWithKey(db, "djdl", {
      maxVersion: "2.0.0",
    });
    const token = await activate(env, db, product, key, "dev-1");
    const res = await handleLicenseDocument(
      mkReq("GET", {
        authorization: `Bearer ${token}`,
        "x-pkey-version": "3.0.0",
      }),
      env,
      db,
      product,
      NOW,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: { code: "version_blocked", reason: "version-too-new" },
      allowedRange: { max: "2.0.0" },
    });
    // A build inside the tightened window still passes.
    const okRes = await handleLicenseDocument(
      mkReq("GET", {
        authorization: `Bearer ${token}`,
        "x-pkey-version": "1.5.0",
      }),
      env,
      db,
      product,
      NOW,
    );
    expect(okRes.status).toBe(200);
  });

  it("a tier's channels/window flow through to a license that has none of its own", async () => {
    await seedTier(db, "djdl", "beta", {
      channels: ["staging"],
      maxVersion: "2.0.0",
    });
    const { key } = await seedLicenseWithKey(db, "djdl", { tierId: "beta" });
    const token = await activate(env, db, product, key, "dev-1");

    // The tier's channel grant lets a staging build (signalled via header) through.
    const chanRes = await handleLicenseDocument(
      mkReq("GET", {
        authorization: `Bearer ${token}`,
        "x-pkey-version": "1.5.0",
        "x-pkey-channel": "staging",
      }),
      env,
      db,
      product,
      NOW,
    );
    expect(chanRes.status).toBe(200);

    // The tier's maxVersion window blocks a too-new stable build.
    const winRes = await handleLicenseDocument(
      mkReq("GET", {
        authorization: `Bearer ${token}`,
        "x-pkey-version": "3.0.0",
      }),
      env,
      db,
      product,
      NOW,
    );
    expect(winRes.status).toBe(403);
    expect(await winRes.json()).toMatchObject({
      error: { code: "version_blocked", reason: "version-too-new" },
    });
  });
});
