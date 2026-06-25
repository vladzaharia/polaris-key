import { describe, expect, it } from "vitest";
import { clientIp, rateLimitOk } from "../src/rateLimit.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, mkReq, NOW, seedLicenseWithKey, seedProduct } from "./seed.js";
import { loadProduct } from "../src/product.js";
import { handleEnroll } from "../src/licensing.js";

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
    expect(clientIp(mkReq("POST", { "cf-connecting-ip": "203.0.113.7" }))).toBe("203.0.113.7");
    // x-forwarded-for alone must NOT set the limit key (it is client-controlled).
    expect(clientIp(mkReq("POST", { "x-forwarded-for": "1.2.3.4" }))).toBe("unknown");
    // even with both, the trusted edge header wins.
    expect(
      clientIp(mkReq("POST", { "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "1.2.3.4" })),
    ).toBe("203.0.113.7");
  });
});

describe("enroll rate limiting", () => {
  it("429s once the per-IP enroll window limit is exceeded", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    const product = (await loadProduct(env, db, "djdl"))!;
    const { key } = await seedLicenseWithKey(db, "djdl");
    // Re-enrolling the same device avoids the machine limit; the 31st trips the rate limit.
    for (let i = 0; i < 30; i++) {
      const res = await handleEnroll(
        mkReq("POST", { authorization: `Bearer ${key}`, "x-pkey-device": "dev-1" }),
        env, db, product, NOW,
      );
      expect(res.status).toBe(200);
    }
    const blocked = await handleEnroll(
      mkReq("POST", { authorization: `Bearer ${key}`, "x-pkey-device": "dev-1" }),
      env, db, product, NOW,
    );
    expect(blocked.status).toBe(429);
  });
});
