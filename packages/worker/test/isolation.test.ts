import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, mkReq, NOW, seedLicenseWithKey, seedProduct } from "./seed.js";
import { loadProduct, type Product } from "../src/product.js";
import { handleConfig, handleEnroll } from "../src/licensing.js";
import type { Env } from "../src/env.js";
import type { SqliteDb } from "../src/db/sqlite.js";

// Multi-tenant isolation, proven by DRIVING THE WORKER — not by inspecting the harness.
// Two real products (djdl, acme) each get a license + an enrolled device + a bearer token;
// we then show each token is accepted by ITS product and rejected (401) by the other. The
// previous version asserted the mock seeded `p:djdl:` keys, which proved the test fixture,
// not the worker. The KV-prefix check survives only as a SECONDARY, defense-in-depth assert.

interface Tenant {
  product: Product;
  token: string;
}

async function enroll(env: Env, db: SqliteDb, product: Product, device: string): Promise<string> {
  const { key } = await seedLicenseWithKey(db, product.slug, { id: `lic_${product.slug}_iso` });
  const res = await handleEnroll(
    mkReq("POST", { authorization: `Bearer ${key}`, "x-pkey-device": device }),
    env, db, product, NOW,
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

const config = (env: Env, db: SqliteDb, product: Product, token: string) =>
  handleConfig(
    mkReq("GET", { authorization: `Bearer ${token}`, "x-pkey-version": "1.0.0" }),
    env, db, product, NOW,
  );

describe("multi-tenant isolation (driven through the worker)", () => {
  it("a bearer token is accepted by its own product and rejected (401) by another", async () => {
    const db = makeTestDb();
    const kv = new KvMock();
    const env = makeEnv(kv, ["djdl", "acme"]);
    await seedProduct(db, "djdl");
    await seedProduct(db, "acme");
    const djdlProduct = (await loadProduct(env, db, "djdl"))!;
    const acmeProduct = (await loadProduct(env, db, "acme"))!;

    // Each tenant: its own license + enrolled device + per-machine token.
    const djdl: Tenant = { product: djdlProduct, token: await enroll(env, db, djdlProduct, "dev-djdl") };
    const acme: Tenant = { product: acmeProduct, token: await enroll(env, db, acmeProduct, "dev-acme") };

    // Each token works at its own product (200).
    expect((await config(env, db, djdl.product, djdl.token)).status).toBe(200);
    expect((await config(env, db, acme.product, acme.token)).status).toBe(200);

    // The WORKER rejects each token cross-tenant: the token record is product-scoped, so a
    // djdl token is unknown under acme (and vice-versa) ⇒ 401. This is the worker enforcing
    // isolation — not the harness.
    expect((await config(env, db, acme.product, djdl.token)).status).toBe(401);
    expect((await config(env, db, djdl.product, acme.token)).status).toBe(401);
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

  it("secondary: every KV key the worker writes is namespaced to its own product", async () => {
    const db = makeTestDb();
    const kv = new KvMock();
    const env = makeEnv(kv, ["djdl", "acme"]);
    await seedProduct(db, "djdl");
    await seedProduct(db, "acme");
    const djdl = (await loadProduct(env, db, "djdl"))!;
    const acme = (await loadProduct(env, db, "acme"))!;
    await enroll(env, db, djdl, "dev-djdl");
    await enroll(env, db, acme, "dev-acme");

    // Defense-in-depth on the structural claim: enrolling in BOTH products produces ONLY
    // `p:<slug>:`-prefixed keys, and never leaks one tenant's keys under the other's prefix.
    expect(kv.keys().length).toBeGreaterThan(0);
    expect(kv.keys().every((k) => k.startsWith("p:djdl:") || k.startsWith("p:acme:"))).toBe(true);
    expect(kv.keys().some((k) => k.startsWith("p:djdl:"))).toBe(true);
    expect(kv.keys().some((k) => k.startsWith("p:acme:"))).toBe(true);
  });
});
