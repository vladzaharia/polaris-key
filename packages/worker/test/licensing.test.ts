import { beforeEach, describe, expect, it } from "vitest";
import { verifyJws } from "@polaris-key/jws";
import type { ManagedConfigDoc } from "@polaris-key/protocol";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, mkReq, NOW, seedLicenseWithKey, seedProduct, TEST_KID, TEST_PUB } from "./seed.js";
import { loadProduct, type Product } from "../src/product.js";
import { handleConfig, handleEnroll } from "../src/licensing.js";
import type { Env } from "../src/env.js";
import type { SqliteDb } from "../src/db/sqlite.js";

const TRUST = { [TEST_KID]: TEST_PUB };

async function enroll(env: Env, db: SqliteDb, product: Product, key: string, device: string): Promise<string> {
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
      entitlements: { polarisVpn: { state: "enforced", value: true, updatedAt: NOW } },
    });
    const token = await enroll(env, db, product, key, "dev-1");

    const res = await handleConfig(
      mkReq("GET", { authorization: `Bearer ${token}`, "x-pkey-version": "1.2.3" }),
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
      mkReq("GET", { authorization: `Bearer ${token}`, "x-pkey-version": "1.2.3" }),
      env, db, product, NOW,
    );
    const etag = first.headers.get("etag")!;
    expect(etag).toBeTruthy();
    const second = await handleConfig(
      mkReq("GET", { authorization: `Bearer ${token}`, "x-pkey-version": "1.2.3", "if-none-match": etag }),
      env, db, product, NOW,
    );
    expect(second.status).toBe(304);
  });

  it("enforces the machine limit", async () => {
    const { key } = await seedLicenseWithKey(db, "djdl", {
      entitlements: { machineLimit: { state: "enforced", value: 1, updatedAt: NOW } },
    });
    await enroll(env, db, product, key, "dev-1");
    const res = await handleEnroll(
      mkReq("POST", { authorization: `Bearer ${key}`, "x-pkey-device": "dev-2" }),
      env, db, product, NOW,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; limit: number };
    expect(body.error).toBe("machine_limit");
    expect(body.limit).toBe(1);
  });

  it("re-enrolling the same device does not consume another machine slot", async () => {
    const { key } = await seedLicenseWithKey(db, "djdl", {
      entitlements: { machineLimit: { state: "enforced", value: 1, updatedAt: NOW } },
    });
    await enroll(env, db, product, key, "dev-1");
    const again = await handleEnroll(
      mkReq("POST", { authorization: `Bearer ${key}`, "x-pkey-device": "dev-1" }),
      env, db, product, NOW,
    );
    expect(again.status).toBe(200);
  });

  it("blocks a build below app.minVersion with allowedRange", async () => {
    const { key } = await seedLicenseWithKey(db, "djdl", {
      entitlements: { "app.minVersion": { state: "enforced", value: "2.0.0", updatedAt: NOW } },
    });
    const token = await enroll(env, db, product, key, "dev-1");
    const res = await handleConfig(
      mkReq("GET", { authorization: `Bearer ${token}`, "x-pkey-version": "1.0.0" }),
      env, db, product, NOW,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { reason: string; allowedRange: { min: string } };
    expect(body.reason).toBe("version-too-old");
    expect(body.allowedRange.min).toBe("2.0.0");
  });

  it("rejects an unknown token", async () => {
    const res = await handleConfig(
      mkReq("GET", { authorization: "Bearer pkeyt_nope", "x-pkey-version": "1.2.3" }),
      env, db, product, NOW,
    );
    expect(res.status).toBe(401);
  });
});
