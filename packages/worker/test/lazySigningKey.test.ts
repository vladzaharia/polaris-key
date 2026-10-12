import { describe, expect, it } from "vitest";
import { dispatchWith } from "../src/dispatch.js";
import { loadProduct } from "../src/core/products.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";

describe("lazy product signing keys", () => {
  it("treats a product without an active key as not found", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    await db.run("DELETE FROM product_keys WHERE product = ?", "djdl");

    const res = await dispatchWith(
      new Request("https://key.plrs.im/djdl/.well-known/jwks.json"),
      env,
      db,
      NOW,
    );

    expect(res.status).toBe(404);
  });

  it("keeps public routes available when only the sealed signing key is unreadable", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    const product = await loadProduct(env, db, "djdl");
    expect(product).not.toBeNull();
    env.PLATFORM_KEK = btoa(String.fromCharCode(1).repeat(32));

    const first = product!.signingKey();
    const second = product!.signingKey();
    expect(first).toBe(second);
    expect(await first).toBeNull();

    const jwks = await dispatchWith(
      new Request("https://key.plrs.im/djdl/.well-known/jwks.json"),
      env,
      db,
      NOW,
    );
    expect(jwks.status).toBe(200);

    const discovery = await dispatchWith(
      new Request("https://key.plrs.im/djdl/.well-known/polaris.json"),
      env,
      db,
      NOW,
    );
    expect(discovery.status).toBe(200);

    const trust = await dispatchWith(
      new Request("https://key.plrs.im/djdl/.well-known/polaris-trust.jws"),
      env,
      db,
      NOW,
    );
    expect(trust.status).toBe(404);
  });
});
