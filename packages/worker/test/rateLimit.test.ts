import { describe, expect, it } from "vitest";
import {
  clientIp,
  clientNetwork,
  RL_SHARDS,
  rateLimitOk,
  rateLimitShard,
  shardIndex,
  wideNetworkOf,
} from "../src/core/rateLimit.js";
import { handlePortalLogin } from "../src/services/identity/portal/auth.js";
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
import {
  handleActivate,
  handleDeauthorize,
} from "../src/services/license/activation.js";
import { handleRegister } from "../src/core/register.js";
import { SERVICES } from "../src/mount.js";
import { serializeServices } from "../src/core/services.js";
import { setServices } from "../src/core/repo.js";

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

// R10-04a (I-02): `_portal` and `_admin` were literal Durable Object names, so every customer's
// and every operator's sign-in serialised through two objects.
describe("rate-limit sharding (R10-04a)", () => {
  /** The object names a mock RL namespace was asked for. */
  function recordShards(env: ReturnType<typeof makeEnv>): string[] {
    const names: string[] = [];
    const ns = env.RL;
    const idFromName = ns.idFromName.bind(ns);
    ns.idFromName = (name: string) => {
      names.push(name);
      return idFromName(name);
    };
    return names;
  }

  it("spreads the _portal and _admin limiters over RL_SHARDS objects", () => {
    for (const limiter of ["_portal", "_admin"]) {
      const shards = new Set<string>();
      for (let i = 0; i < 2000; i++) {
        shards.add(
          rateLimitShard(limiter, {
            bucket: "portalLogin",
            id: `198.51.100.${i % 256}:${i}`,
            limit: 1,
            windowSec: 60,
          }),
        );
      }
      expect(shards.size).toBe(RL_SHARDS);
      for (const name of shards)
        expect(name).toMatch(new RegExp(`^${limiter}:\\d+$`));
    }
  });

  it("keeps one counter in exactly one object, so the limit stays exact", async () => {
    const env = makeEnv(new KvMock(), []);
    const names = recordShards(env);
    const rl = {
      bucket: "portalLogin",
      id: "203.0.113.9",
      limit: 3,
      windowSec: 60,
    };
    const results = await Promise.all(
      Array.from({ length: 12 }, () => rateLimitOk(env, "_portal", rl, NOW)),
    );
    expect(results.filter(Boolean).length).toBe(3);
    expect(new Set(names).size).toBe(1);
    expect(names[0]).toBe(
      `_portal:${shardIndex("portalLogin:203.0.113.9", RL_SHARDS)}`,
    );
  });

  it("gives two clients of one limiter independent budgets in (usually) different objects", async () => {
    const env = makeEnv(new KvMock(), []);
    const a = {
      bucket: "adminLogin",
      id: "192.0.2.1",
      limit: 1,
      windowSec: 60,
    };
    const b = { ...a, id: "192.0.2.2" };
    expect(await rateLimitOk(env, "_admin", a, NOW)).toBe(true);
    expect(await rateLimitOk(env, "_admin", a, NOW)).toBe(false);
    expect(await rateLimitOk(env, "_admin", b, NOW)).toBe(true);
  });

  it("leaves a product's own limiter as one object per product", () => {
    const rl = { bucket: "activate", id: "x", limit: 1, windowSec: 60 };
    expect(rateLimitShard("djdl", rl)).toBe("djdl");
    expect(rateLimitShard("djdl", { ...rl, id: "y" })).toBe("djdl");
  });

  it("shards the email buckets in every limiter", () => {
    const rl = {
      bucket: "emailSendRecipientHour",
      id: "h",
      limit: 1,
      windowSec: 60,
    };
    expect(rateLimitShard("djdl", rl)).toBe(
      `djdl:${shardIndex("emailSendRecipientHour:h", RL_SHARDS)}`,
    );
  });

  it("routes portal sign-in through a _portal shard, not the literal `_portal` object", async () => {
    const env = makeEnv(new KvMock(), []);
    const names = recordShards(env);
    await handlePortalLogin(
      mkReq("GET", { "cf-connecting-ip": "203.0.113.50" }),
      env,
      makeTestDb(),
    );
    expect(names.length).toBeGreaterThan(0);
    expect(names).not.toContain("_portal");
    expect(names.every((n) => /^_portal:\d+$/.test(n))).toBe(true);
  });
});

describe("wideNetworkOf", () => {
  it("collapses IPv4 to its /24 and IPv6 to its /48", () => {
    expect(wideNetworkOf("192.0.2.77")).toBe("192.0.2.0/24");
    expect(wideNetworkOf("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1::/48");
    expect(wideNetworkOf("2001:db8:1::9")).toBe("2001:db8:1::/48");
    expect(wideNetworkOf("unknown")).toBe("unknown");
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

describe("clientNetwork", () => {
  const net = (ip?: string): string =>
    clientNetwork(mkReq("GET", ip ? { "cf-connecting-ip": ip } : {}));

  it("keeps an IPv4 address whole", () => {
    expect(net("203.0.113.7")).toBe("203.0.113.7");
  });

  it("collapses an IPv6 address to its /64, however it is written", () => {
    // R10-04b: one host holds the whole /64, so every address in it is the same client.
    const a = net("2001:db8:abcd:12::1");
    expect(a).toBe("2001:db8:abcd:12::/64");
    expect(net("2001:0DB8:ABCD:0012:ffff:ffff:ffff:ffff")).toBe(a);
    expect(net("2001:db8:abcd:12:1234::9")).toBe(a);
    expect(net("2001:db8:abcd:12::1%eth0")).toBe(a);
    // A neighbouring /64 is a different client.
    expect(net("2001:db8:abcd:13::1")).toBe("2001:db8:abcd:13::/64");
    expect(net("::1")).toBe("0:0:0:0::/64");
    // An IPv4-mapped address is its IPv4 address, not one shared ::/64 bucket.
    expect(net("::ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(net("::ffff:c000:201")).toBe("192.0.2.1");
    expect(net("2001:db8::")).toBe("2001:db8:0:0::/64");
  });

  it("falls back to the raw value when the address does not parse", () => {
    expect(net("2001:db8:::1")).toBe("2001:db8:::1");
    expect(net("1:2:3:4:5:6:7:8:9")).toBe("1:2:3:4:5:6:7:8:9");
    expect(net("zz::1")).toBe("zz::1");
    expect(net()).toBe("unknown");
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
          distribution: { enabled: false },
          update: { enabled: false },
          identity: { enabled: false },
          sync: { enabled: false },
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
          "x-pkey-device": "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH",
        }),
        env,
        db,
        product,
        NOW,
        SERVICES,
      );
    for (let i = 0; i < 10; i++) expect((await call()).status).toBe(200);
    const blocked = await call();
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ error: { code: "rate_limited" } });
  });

  it("rotating addresses inside one IPv6 /64 does not mint fresh budgets", async () => {
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
          distribution: { enabled: false },
          update: { enabled: false },
          identity: { enabled: false },
          sync: { enabled: false },
        },
      }),
      "manifest",
      NOW,
    );
    const product = (await loadProduct(env, db, "djdl"))!;
    const statuses: number[] = [];
    for (let i = 0; i < 30; i++) {
      const res = await handleRegister(
        mkReq("POST", {
          "cf-connecting-ip": `2001:db8:1:2::${i + 1}`,
          "x-pkey-device": "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH",
        }),
        env,
        db,
        product,
        NOW,
        SERVICES,
      );
      statuses.push(res.status);
    }
    expect(statuses.filter((s) => s === 200)).toHaveLength(10);
    expect(statuses.filter((s) => s === 429)).toHaveLength(20);
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
          "x-pkey-device": "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH",
        }),
        env,
        db,
        product,
        NOW,
        SERVICES,
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
          "x-pkey-device": "dev-1",
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
        "x-pkey-device": "dev-1",
      }),
      env,
      db,
      product,
      NOW,
    );
    expect(blocked.status).toBe(429);
  });
});

describe("deauthorize rate limiting", () => {
  it("429s a /64 after 30 attempts, before any token work", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    const product = (await loadProduct(env, db, "djdl"))!;
    const statuses: number[] = [];
    for (let i = 0; i < 35; i++) {
      const res = await handleDeauthorize(
        mkReq("POST", { "cf-connecting-ip": `2001:db8:9:9::${i + 1}` }),
        env,
        db,
        product,
      );
      statuses.push(res.status);
    }
    expect(statuses.filter((s) => s === 401)).toHaveLength(30);
    expect(statuses.filter((s) => s === 429)).toHaveLength(5);
  });
});
