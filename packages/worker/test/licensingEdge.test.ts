import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import {
  UNKNOWN_DEVICE_TOKEN,
  makeEnv,
  mkReq,
  NOW,
  seedLicenseWithKey,
  seedProduct,
} from "./seed.js";
import { loadProduct, type Product } from "../src/core/products.js";
import {
  handleDeauthorize,
  handleActivate,
  handleToken,
} from "../src/services/license/activation.js";
import { handleLicenseDocument } from "../src/services/license/document.js";
import { handleReport } from "../src/core/devices.js";
import { getDevice, setKeyStatus } from "../src/repo.js";
import type { Env } from "../src/env.js";
import type { SqliteDb } from "../src/db/sqlite.js";

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
  return ((await res.json()) as { token: string }).token;
}

const cfg = (token: string) =>
  mkReq("GET", {
    authorization: `Bearer ${token}`,
    "x-pkey-version": "1.2.3",
  });

describe("licensing edge cases", () => {
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
  });

  // ── activate preconditions ─────────────────────────────────────────────────
  it("activate requires a bearer key", async () => {
    const res = await handleActivate(
      mkReq("POST", { "x-pkey-device": "dev-1" }),
      env,
      db,
      product,
      NOW,
    );
    expect(res.status).toBe(401);
  });

  it("activate requires a device id", async () => {
    const { key } = await seedLicenseWithKey(db, "djdl");
    const res = await handleActivate(
      mkReq("POST", { authorization: `Bearer ${key}` }),
      env,
      db,
      product,
      NOW,
    );
    expect(res.status).toBe(400);
  });

  it("activate rejects a non-POST method", async () => {
    const res = await handleActivate(
      mkReq("GET", { authorization: "Bearer x", "x-pkey-device": "d" }),
      env,
      db,
      product,
      NOW,
    );
    expect(res.status).toBe(405);
  });

  // ── license/key state gating ─────────────────────────────────────────────
  it("rejects activate on an expired license", async () => {
    const { key } = await seedLicenseWithKey(db, "djdl", {
      expiresAt: NOW - 1,
    });
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
    expect(res.status).toBe(401);
  });

  it("rejects activate on a disabled license", async () => {
    const { key } = await seedLicenseWithKey(db, "djdl");
    await db.run(
      "UPDATE licenses SET status = 'disabled' WHERE product = ? AND id = 'lic_djdl_1'",
      "djdl",
    );
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
    expect(res.status).toBe(401);
  });

  it("rejects activate on a revoked key", async () => {
    const { key } = await seedLicenseWithKey(db, "djdl");
    const { hashKey } = await import("../src/crypto.js");
    await setKeyStatus(db, "djdl", await hashKey(key), "revoked");
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
    expect(res.status).toBe(401);
  });

  it("config returns 403 (not 200) once the license expires after activate", async () => {
    const { key } = await seedLicenseWithKey(db, "djdl");
    const token = await activate(env, db, product, key, "dev-1");
    // Same token, but checked at a time past the expiry that we now set.
    await db.run(
      "UPDATE licenses SET expires_at = ? WHERE product = 'djdl' AND id = 'lic_djdl_1'",
      NOW + 10,
    );
    const res = await handleLicenseDocument(
      cfg(token),
      env,
      db,
      product,
      NOW + 100,
    );
    expect(res.status).toBe(401);
  });

  // ── deauthorize ──────────────────────────────────────────────────────────
  it("deauthorize then config returns 401", async () => {
    const { key } = await seedLicenseWithKey(db, "djdl");
    const token = await activate(env, db, product, key, "dev-1");

    const deauth = await handleDeauthorize(
      mkReq("POST", { authorization: `Bearer ${token}` }),
      env,
      db,
      product,
    );
    expect(deauth.status).toBe(200);
    // The KV token record is gone → config is unauthorized.
    const res = await handleLicenseDocument(cfg(token), env, db, product, NOW);
    expect(res.status).toBe(401);
    // And the device row flips to deauthorized.
    expect((await getDevice(db, "djdl", "dev-1"))?.status).toBe("deauthorized");
  });

  it("deauthorize rejects an unknown token", async () => {
    const res = await handleDeauthorize(
      mkReq("POST", { authorization: `Bearer ${UNKNOWN_DEVICE_TOKEN}` }),
      env,
      db,
      product,
    );
    expect(res.status).toBe(401);
  });

  // ── report ───────────────────────────────────────────────────────────────
  it("report stores the device's reported snapshot", async () => {
    const { key } = await seedLicenseWithKey(db, "djdl");
    const token = await activate(env, db, product, key, "dev-1");
    const snapshot = {
      appVersion: "1.2.3",
      platform: "darwin",
      config: { proxy: "on" },
      entitlements: { beta: true },
      gate: { licensed: true },
      ignoredSecret: "do-not-store",
    };
    const res = await handleReport(
      mkReq("POST", { authorization: `Bearer ${token}` }, snapshot),
      env,
      db,
      product,
      NOW + 5,
    );
    expect(res.status).toBe(200);
    const m = await getDevice(db, "djdl", "dev-1");
    expect(JSON.parse(m!.reported_json!)).toEqual({
      appVersion: "1.2.3",
      platform: "darwin",
      config: { proxy: "on" },
      entitlements: { beta: true },
      gate: { licensed: true },
    });
    expect(m!.last_seen).toBe(NOW + 5);
  });

  it("report rejects an unknown token / invalid body", async () => {
    expect(
      (
        await handleReport(
          mkReq(
            "POST",
            { authorization: `Bearer ${UNKNOWN_DEVICE_TOKEN}` },
            {},
          ),
          env,
          db,
          product,
          NOW,
        )
      ).status,
    ).toBe(401);
    const { key } = await seedLicenseWithKey(db, "djdl");
    const token = await activate(env, db, product, key, "dev-1");
    const badBody = new Request("https://key.plrs.im/x", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: "{not json",
    }) as unknown as Request;
    expect((await handleReport(badBody, env, db, product, NOW)).status).toBe(
      400,
    );
  });

  // ── token re-acquire ─────────────────────────────────────────────────────
  it("token re-acquire requires the current token, mints a fresh token, and invalidates the old one", async () => {
    const { key } = await seedLicenseWithKey(db, "djdl");
    const oldToken = await activate(env, db, product, key, "dev-1");

    const withoutBearer = await handleToken(
      mkReq("POST", { "x-pkey-device": "dev-1" }),
      env,
      db,
      product,
      NOW + 1,
    );
    expect(withoutBearer.status).toBe(401);

    const wrongDevice = await handleToken(
      mkReq("POST", {
        authorization: `Bearer ${oldToken}`,
        "x-pkey-device": "dev-2",
      }),
      env,
      db,
      product,
      NOW + 1,
    );
    expect(wrongDevice.status).toBe(401);

    const res = await handleToken(
      mkReq("POST", {
        authorization: `Bearer ${oldToken}`,
        "x-pkey-device": "dev-1",
      }),
      env,
      db,
      product,
      NOW + 1,
    );
    expect(res.status).toBe(200);
    const newToken = ((await res.json()) as { token: string }).token;
    expect(newToken).not.toBe(oldToken);

    // Old token no longer authenticates; new token does.
    expect(
      (await handleLicenseDocument(cfg(oldToken), env, db, product, NOW + 1))
        .status,
    ).toBe(401);
    expect(
      (await handleLicenseDocument(cfg(newToken), env, db, product, NOW + 1))
        .status,
    ).toBe(200);
  });

  it("token re-acquire requires an authorized device", async () => {
    // Never activated.
    const res = await handleToken(
      mkReq("POST", { "x-pkey-device": "ghost" }),
      env,
      db,
      product,
      NOW,
    );
    expect(res.status).toBe(401);
  });

  it("token re-acquire fails after deauthorization", async () => {
    const { key } = await seedLicenseWithKey(db, "djdl");
    const token = await activate(env, db, product, key, "dev-1");
    await handleDeauthorize(
      mkReq("POST", { authorization: `Bearer ${token}` }),
      env,
      db,
      product,
    );
    const res = await handleToken(
      mkReq("POST", {
        authorization: `Bearer ${token}`,
        "x-pkey-device": "dev-1",
      }),
      env,
      db,
      product,
      NOW,
    );
    expect(res.status).toBe(401);
  });

  // ── ETag stability ───────────────────────────────────────────────────────
  it("two identical configs produce a stable ETag (304)", async () => {
    const { key } = await seedLicenseWithKey(db, "djdl");
    const token = await activate(env, db, product, key, "dev-1");
    const first = await handleLicenseDocument(
      cfg(token),
      env,
      db,
      product,
      NOW,
    );
    const etag = first.headers.get("etag")!;
    // Even at a later `now` (different issuedAt) the content ETag is unchanged.
    const second = await handleLicenseDocument(
      mkReq("GET", {
        authorization: `Bearer ${token}`,
        "x-pkey-version": "1.2.3",
        "if-none-match": etag,
      }),
      env,
      db,
      product,
      NOW + 50_000,
    );
    expect(second.status).toBe(304);
    expect(second.headers.get("etag")).toBe(etag);
  });

  // ── device-limit boundaries ─────────────────────────────────────────────
  it("allows activation up to exactly the limit, then blocks (count == limit)", async () => {
    const { key } = await seedLicenseWithKey(db, "djdl", {
      entitlements: {
        deviceLimit: { state: "enforced", value: 2, updatedAt: NOW },
      },
    });
    await activate(env, db, product, key, "dev-1");
    await activate(env, db, product, key, "dev-2");
    const blocked = await handleActivate(
      mkReq("POST", {
        authorization: `Bearer ${key}`,
        "x-pkey-device": "dev-3",
      }),
      env,
      db,
      product,
      NOW,
    );
    expect(blocked.status).toBe(403);
    const body = (await blocked.json()) as {
      limit: number;
      deviceCount: number;
    };
    expect(body.limit).toBe(2);
    expect(body.deviceCount).toBe(2);
  });

  it("FIXED (R11-02): a deviceLimit of 0 denies rather than meaning unlimited", async () => {
    // Was: `if (limit > 0)` skipped the seat check entirely for a non-positive limit, so a
    // mistyped, fuzzed or hostile `deviceLimit: 0` was the strongest possible entitlement.
    // The tier and product COLUMNS now reject `<= 0` at the DB, but a stored entitlement
    // override is JSON, so the code must fail closed on its own.
    const { key } = await seedLicenseWithKey(db, "djdl", {
      entitlements: {
        deviceLimit: { state: "enforced", value: 0, updatedAt: NOW },
      },
    });
    const res = await handleActivate(
      mkReq("POST", {
        authorization: `Bearer ${key}`,
        "x-pkey-device": "a",
      }),
      env,
      db,
      product,
      NOW,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ limit: 0, deviceCount: 0 });
  });

  it("re-authorizing a deauthorized device frees no extra slot but re-counts it", async () => {
    const { key } = await seedLicenseWithKey(db, "djdl", {
      entitlements: {
        deviceLimit: { state: "enforced", value: 1, updatedAt: NOW },
      },
    });
    const token = await activate(env, db, product, key, "dev-1");
    await handleDeauthorize(
      mkReq("POST", { authorization: `Bearer ${token}` }),
      env,
      db,
      product,
    );
    // dev-1 is now deauthorized (count 0) → re-activate succeeds.
    const re = await handleActivate(
      mkReq("POST", {
        authorization: `Bearer ${key}`,
        "x-pkey-device": "dev-1",
      }),
      env,
      db,
      product,
      NOW,
    );
    expect(re.status).toBe(200);
  });
});
