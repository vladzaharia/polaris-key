import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, mkReq, NOW, seedLicenseWithKey, seedProduct } from "./seed.js";
import { loadProduct } from "../src/product.js";
import { handleConfig, handleEnroll } from "../src/licensing.js";

describe("multi-tenant isolation", () => {
  it("a token enrolled in product A is rejected at product B", async () => {
    const db = makeTestDb();
    const kv = new KvMock();
    const env = makeEnv(kv, ["djdl", "acme"]);
    await seedProduct(db, "djdl");
    await seedProduct(db, "acme");
    const djdl = (await loadProduct(env, db, "djdl"))!;
    const acme = (await loadProduct(env, db, "acme"))!;

    const { key } = await seedLicenseWithKey(db, "djdl");
    const enrollRes = await handleEnroll(
      mkReq("POST", { authorization: `Bearer ${key}`, "x-pkey-device": "dev-1" }),
      env, db, djdl, NOW,
    );
    const { token } = (await enrollRes.json()) as { token: string };

    const okHere = await handleConfig(
      mkReq("GET", { authorization: `Bearer ${token}`, "x-pkey-version": "1.0.0" }),
      env, db, djdl, NOW,
    );
    expect(okHere.status).toBe(200);

    const deniedThere = await handleConfig(
      mkReq("GET", { authorization: `Bearer ${token}`, "x-pkey-version": "1.0.0" }),
      env, db, acme, NOW,
    );
    expect(deniedThere.status).toBe(401);
  });

  it("a license key from product A cannot enroll at product B", async () => {
    const db = makeTestDb();
    const kv = new KvMock();
    const env = makeEnv(kv, ["djdl", "acme"]);
    await seedProduct(db, "djdl");
    await seedProduct(db, "acme");
    const acme = (await loadProduct(env, db, "acme"))!;
    const { key } = await seedLicenseWithKey(db, "djdl");
    const res = await handleEnroll(
      mkReq("POST", { authorization: `Bearer ${key}`, "x-pkey-device": "dev-1" }),
      env, db, acme, NOW,
    );
    expect(res.status).toBe(401);
  });

  it("every KV key written is product-prefixed", async () => {
    const db = makeTestDb();
    const kv = new KvMock();
    const env = makeEnv(kv, ["djdl"]);
    await seedProduct(db, "djdl");
    const djdl = (await loadProduct(env, db, "djdl"))!;
    const { key } = await seedLicenseWithKey(db, "djdl");
    await handleEnroll(
      mkReq("POST", { authorization: `Bearer ${key}`, "x-pkey-device": "dev-1" }),
      env, db, djdl, NOW,
    );
    expect(kv.keys().length).toBeGreaterThan(0);
    expect(kv.keys().every((k) => k.startsWith("p:djdl:"))).toBe(true);
  });
});
