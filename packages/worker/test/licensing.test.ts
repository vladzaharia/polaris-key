import { beforeEach, describe, expect, it } from "vitest";
import { verifyJws } from "@polaris-key/jws";
import type { ManagedConfigDoc } from "@polaris-key/protocol";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import {
  makeEnv,
  mkReq,
  NOW,
  seedLicenseWithKey,
  seedProduct,
  seedTier,
  TEST_KID,
  TEST_PUB,
} from "./seed.js";
import { loadProduct, type Product } from "../src/product.js";
import { handleConfig, handleEnroll, handleToken } from "../src/licensing.js";
import type { Env } from "../src/env.js";
import type { SqliteDb } from "../src/db/sqlite.js";
import { hashKey } from "../src/crypto.js";
import { getTokenRecord } from "../src/kv.js";
import { setLicenseProfiles } from "../src/repo.js";

const TRUST = { [TEST_KID]: TEST_PUB };

async function enroll(
  env: Env,
  db: SqliteDb,
  product: Product,
  key: string,
  device: string,
): Promise<string> {
  const res = await handleEnroll(
    mkReq("POST", { authorization: `Bearer ${key}`, "x-pkey-device": device }),
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

  it("enroll → config returns a verifiable signed doc scoped to the product", async () => {
    const { licenseId, key } = await seedLicenseWithKey(db, "djdl", {
      entitlements: {
        polarisVpn: { state: "enforced", value: true, updatedAt: NOW },
      },
    });
    const token = await enroll(env, db, product, key, "dev-1");

    const res = await handleConfig(
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
    const jws = await res.text();
    const v = await verifyJws<ManagedConfigDoc>(jws, TRUST);
    expect(v).not.toBeNull();
    expect(v!.kid).toBe(TEST_KID);
    expect(v!.payload.aud).toBe("djdl");
    expect(v!.payload.iss).toBe("key.plrs.im");
    expect(v!.payload.deviceId).toBe("dev-1");
    expect(v!.payload.licenseId).toBe(licenseId);
    expect(v!.payload.payload.entitlements.polarisVpn?.value).toBe(true);
  });

  it("returns 304 when If-None-Match matches", async () => {
    const { key } = await seedLicenseWithKey(db, "djdl");
    const token = await enroll(env, db, product, key, "dev-1");
    const first = await handleConfig(
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
    const second = await handleConfig(
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

  it("enforces the machine limit", async () => {
    const { key } = await seedLicenseWithKey(db, "djdl", {
      entitlements: {
        machineLimit: { state: "enforced", value: 1, updatedAt: NOW },
      },
    });
    await enroll(env, db, product, key, "dev-1");
    const res = await handleEnroll(
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
    expect(body.error).toBe("machine_limit");
    expect(body.limit).toBe(1);
  });

  it("re-enrolling the same device does not consume another machine slot", async () => {
    const { key } = await seedLicenseWithKey(db, "djdl", {
      entitlements: {
        machineLimit: { state: "enforced", value: 1, updatedAt: NOW },
      },
    });
    await enroll(env, db, product, key, "dev-1");
    const again = await handleEnroll(
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
    const token = await enroll(env, db, product, key, "dev-1");
    const res = await handleConfig(
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
    const body = (await res.json()) as {
      reason: string;
      allowedRange: { min: string };
    };
    expect(body.reason).toBe("version-too-old");
    expect(body.allowedRange.min).toBe("2.0.0");
  });

  it("rejects an unknown token", async () => {
    const res = await handleConfig(
      mkReq("GET", {
        authorization: "Bearer pkeyt_nope",
        "x-pkey-version": "1.2.3",
      }),
      env,
      db,
      product,
      NOW,
    );
    expect(res.status).toBe(401);
  });

  it("rejects a stale KV token when the machine row points at a different token hash", async () => {
    const { key } = await seedLicenseWithKey(db, "djdl");
    const token = await enroll(env, db, product, key, "dev-1");
    await db.run(
      "UPDATE machines SET token_hash = ? WHERE product = ? AND machine_id = ?",
      "different-hash",
      "djdl",
      "dev-1",
    );

    const res = await handleConfig(
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
    const token = await enroll(env, db, product, key, "dev-1");

    const res = await handleConfig(
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
    const v = await verifyJws<ManagedConfigDoc>(await res.text(), TRUST);
    expect(v!.payload.payload.config["app.theme"]?.value).toBe("dark");
    expect(v!.payload.payload.config["app.region"]?.value).toBe("us");
  });

  it("requires the current bearer token to replace a token", async () => {
    const { key } = await seedLicenseWithKey(db, "djdl");
    await enroll(env, db, product, key, "dev-1");

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
        authorization: "Bearer pkeyt_nope",
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
    const oldToken = await enroll(env, db, product, key, "dev-1");
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
      machineId: "dev-1",
      licenseId: "lic_djdl_1",
    });

    const oldConfig = await handleConfig(
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

    const newConfig = await handleConfig(
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
    const token = await enroll(env, db, product, key, "dev-1");

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

    const stillValid = await handleConfig(
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
    const blockedToken = await enroll(
      env,
      db,
      product,
      blocked.key,
      "dev-block",
    );
    const blockedRes = await handleConfig(
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
    expect(((await blockedRes.json()) as { reason: string }).reason).toBe(
      "channel-not-entitled",
    );

    // A second license with the admin channel policy granted.
    const granted = await seedLicenseWithKey(db, "djdl", {
      id: "lic_djdl_granted",
      channels: ["staging"],
    });
    const grantedToken = await enroll(env, db, product, granted.key, "dev-ok");
    const okRes = await handleConfig(
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

  it("an admin maxVersion narrower than the product compat_max blocks a too-new build", async () => {
    // Product compat window is 0.0.0..99.0.0; admin caps at 2.0.0 (tighter wins).
    const { key } = await seedLicenseWithKey(db, "djdl", {
      maxVersion: "2.0.0",
    });
    const token = await enroll(env, db, product, key, "dev-1");
    const res = await handleConfig(
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
    const body = (await res.json()) as {
      reason: string;
      allowedRange: { max: string };
    };
    expect(body.reason).toBe("version-too-new");
    expect(body.allowedRange.max).toBe("2.0.0");
    // A build inside the tightened window still passes.
    const okRes = await handleConfig(
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
    const token = await enroll(env, db, product, key, "dev-1");

    // The tier's channel grant lets a staging build (signalled via header) through.
    const chanRes = await handleConfig(
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
    const winRes = await handleConfig(
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
    expect(((await winRes.json()) as { reason: string }).reason).toBe(
      "version-too-new",
    );
  });
});
