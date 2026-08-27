import { describe, expect, it } from "vitest";
import { clientIp, rateLimitOk } from "../src/core/rateLimit.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import {
  makeEnv,
  mkReq,
  NOW,
  seedLicenseWithKey,
  seedProduct,
} from "./seed.js";
import { loadProduct } from "../src/core/products.js";
import { handleActivate } from "../src/services/license/activation.js";
import { handleRegister } from "../src/core/register.js";
import { serializeServices } from "../src/core/services.js";
import { setServices } from "../src/repo.js";

describe("rateLimitOk", () => {
  it("allows up to the limit within a window, then blocks", async () => {
    const env = makeEnv(new KvMock(), ["djdl"]);
    const rl = { bucket: "x", id: "ip", limit: 3, windowSec: 60 };
    expect(await rateLimitOk(env, "djdl", rl, NOW)).toBe(true);
    expect(await rateLimitOk(env, "djdl", rl, NOW)).toBe(true);
    expect(await rateLimitOk(env, "djdl", rl, NOW)).toBe(true);
    expect(await rateLimitOk(env, "djdl", rl, NOW)).toBe(false);
  });

  it("is atomic under a concurrent burst (never exceeds the limit)", async () => {
    const env = makeEnv(new KvMock(), ["djdl"]);
    const rl = { bucket: "x", id: "ip", limit: 3, windowSec: 60 };
    const results = await Promise.all(
      Array.from({ length: 20 }, () => rateLimitOk(env, "djdl", rl, NOW)),
    );
    expect(results.filter((ok) => ok).length).toBe(3);
  });

  it("uses a fresh counter in the next window", async () => {
    const env = makeEnv(new KvMock(), ["djdl"]);
    const rl = { bucket: "x", id: "ip", limit: 1, windowSec: 60 };
    expect(await rateLimitOk(env, "djdl", rl, NOW)).toBe(true);
    expect(await rateLimitOk(env, "djdl", rl, NOW)).toBe(false);
    expect(await rateLimitOk(env, "djdl", rl, NOW + 60)).toBe(true);
  });

  it("is product-scoped (separate counters per product)", async () => {
    const env = makeEnv(new KvMock(), ["djdl", "acme"]);
    const rl = { bucket: "x", id: "ip", limit: 1, windowSec: 60 };
    expect(await rateLimitOk(env, "djdl", rl, NOW)).toBe(true);
    expect(await rateLimitOk(env, "acme", rl, NOW)).toBe(true);
    expect(await rateLimitOk(env, "djdl", rl, NOW)).toBe(false);
  });
});

describe("clientIp", () => {
  it("uses cf-connecting-ip and ignores the spoofable x-forwarded-for", () => {
    expect(clientIp(mkReq("POST", { "cf-connecting-ip": "203.0.113.7" }))).toBe(
      "203.0.113.7",
    );
    // x-forwarded-for alone must NOT set the limit key (it is client-controlled).
    expect(clientIp(mkReq("POST", { "x-forwarded-for": "1.2.3.4" }))).toBe(
      "unknown",
    );
    // even with both, the trusted edge header wins.
    expect(
      clientIp(
        mkReq("POST", {
          "cf-connecting-ip": "203.0.113.7",
          "x-forwarded-for": "1.2.3.4",
        }),
      ),
    ).toBe("203.0.113.7");
  });
});

describe("register rate limiting", () => {
  it("429s once the per-IP register window limit is exceeded", async () => {
    // The one endpoint that mints a credential from nothing at all, so the limiter is the only
    // thing between an anonymous caller and unbounded token minting.
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    await setServices(
      db,
      "djdl",
      serializeServices({
        services: {
          license: { enabled: false },
          config: { enabled: true },
          release: { enabled: false },
          update: { enabled: false },
          identity: { enabled: false },
        },
      }),
      "manifest",
      NOW,
    );
    const product = (await loadProduct(env, db, "djdl"))!;
    const call = (): Promise<Response> =>
      handleRegister(
        mkReq("POST", {
          "cf-connecting-ip": "203.0.113.9",
          "x-polaris-device": "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH",
        }),
        env,
        db,
        product,
        NOW,
      );
    for (let i = 0; i < 10; i++) expect((await call()).status).toBe(200);
    const blocked = await call();
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ error: { code: "rate_limited" } });
  });

  it("does not spend the budget on a product whose policy refuses anyway", async () => {
    // Refusing before the limiter keeps the closed case cheap under exactly the flood that
    // would try it — and stops a closed product's counter from being exhaustible at all.
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    const product = (await loadProduct(env, db, "djdl"))!;
    expect(product.registration).toBe("requires-license");
    for (let i = 0; i < 50; i++) {
      const res = await handleRegister(
        mkReq("POST", {
          "cf-connecting-ip": "203.0.113.9",
          "x-polaris-device": "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH",
        }),
        env,
        db,
        product,
        NOW,
      );
      expect(res.status).toBe(403);
    }
  });
});

describe("activate rate limiting", () => {
  it("429s once the per-IP activate window limit is exceeded", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    const product = (await loadProduct(env, db, "djdl"))!;
    const { key } = await seedLicenseWithKey(db, "djdl");
    // Re-activating the same device avoids the device limit; the 31st trips the rate limit.
    for (let i = 0; i < 30; i++) {
      const res = await handleActivate(
        mkReq("POST", {
          authorization: `Bearer ${key}`,
          "x-polaris-device": "dev-1",
        }),
        env,
        db,
        product,
        NOW,
      );
      expect(res.status).toBe(200);
    }
    const blocked = await handleActivate(
      mkReq("POST", {
        authorization: `Bearer ${key}`,
        "x-polaris-device": "dev-1",
      }),
      env,
      db,
      product,
      NOW,
    );
    expect(blocked.status).toBe(429);
  });
});
