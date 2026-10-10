/**
 * UX-15: the refusal log (`core/licensing/refusals.ts`, docs/design/EXPERIENCE.md §0.9).
 *
 *   - `authorizeDevice` logs every refusal, with the reason, a plain-text label and a device hash
 *   - with a `waitUntil` the write is handed off, not awaited; without one it runs inline
 *   - a failed write never changes the refusal the device gets
 *   - repeats inside a minute fold into one row
 *   - the nightly sweep prunes rows past 30 days, per product
 *   - `GET /manage/api/products/<slug>/refusals` reads per product and per licence
 *
 * Admin routes are narrative-only (`routeCoverage.test.ts`): no OpenAPI entry.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import {
  makeEnv,
  mkReq,
  NOW,
  seedLicenseWithKey,
  seedProduct,
} from "./seed.js";
import { loadProduct, type Product } from "../src/core/products.js";
import { handleActivate } from "../src/services/license/activation.js";
import { handleLicenseRoutes } from "../src/services/license/routes.js";
import { authorizeDevice } from "../src/core/licensing/authz.js";
import {
  REFUSAL_LABEL_MAX,
  REFUSAL_RETENTION_SECONDS,
  logRefusal,
  recordRefusal,
  refusalDeviceHash,
  sanitizeRefusalLabel,
} from "../src/core/licensing/refusals.js";
import { runScheduledMaintenance } from "../src/scheduled.js";
import { handleAdmin } from "../src/console/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/core/console/session.js";
import { getLicense } from "../src/core/repo.js";
import type { Env } from "../src/platform/env.js";
import type { Db } from "../src/db/types.js";
import type { SqliteDb } from "../src/db/sqlite.js";
import type { ServiceContext } from "../src/core/registry.js";
import { NO_HOOKS, NO_INGEST } from "./helpers.js";

const SLUG = "djdl";
const ONE_SEAT = {
  deviceLimit: { state: "enforced" as const, value: 1, updatedAt: NOW },
};

interface Row {
  product: string;
  license_id: string;
  at: number;
  reason: string;
  device_label: string | null;
  device_hash: string;
}

async function rows(db: Db): Promise<Row[]> {
  return db.all<Row>(
    "SELECT product, license_id, at, reason, device_label, device_hash FROM license_refusals ORDER BY rowid",
  );
}

function activateReq(
  key: string,
  device: string,
  extra: Record<string, string> = {},
): Request {
  return mkReq("POST", {
    authorization: `Bearer ${key}`,
    "x-pkey-device": device,
    ...extra,
  });
}

describe("the refusal site logs refusals", () => {
  let db: SqliteDb;
  let env: Env;
  let product: Product;

  beforeEach(async () => {
    db = makeTestDb();
    env = makeEnv(new KvMock(), [SLUG]);
    await seedProduct(db, SLUG);
    product = (await loadProduct(env, db, SLUG))!;
  });

  it("logs a seat-limit refusal with the reason, a label and the device hash", async () => {
    const { key, licenseId } = await seedLicenseWithKey(db, SLUG, {
      entitlements: ONE_SEAT,
    });
    expect(
      (await handleActivate(activateReq(key, "dev-1"), env, db, product, NOW))
        .status,
    ).toBe(200);
    expect(await rows(db)).toEqual([]);

    const res = await handleActivate(
      activateReq(key, "dev-2", {
        "x-pkey-platform": "macos",
        "x-pkey-arch": "arm64",
      }),
      env,
      db,
      product,
      NOW + 5,
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe(
      "device_limit",
    );
    expect(await rows(db)).toEqual([
      {
        product: SLUG,
        license_id: licenseId,
        at: NOW + 5,
        reason: "device_limit",
        device_label: "macos arm64",
        device_hash: await refusalDeviceHash("dev-2"),
      },
    ]);
  });

  it("prefers the device's own name, when it has a row", async () => {
    const { key, licenseId } = await seedLicenseWithKey(db, SLUG, {
      entitlements: ONE_SEAT,
    });
    await handleActivate(activateReq(key, "dev-1"), env, db, product, NOW);
    // dev-2 was here before (now deauthorized) and was named by its owner.
    await db.run(
      `INSERT INTO devices (product, device_id, license_id, status, first_seen, last_seen, label)
       VALUES (?, ?, ?, 'deauthorized', ?, ?, ?)`,
      SLUG,
      "dev-2",
      licenseId,
      NOW - 100,
      NOW - 100,
      "Studio‮ Laptop",
    );
    await handleActivate(activateReq(key, "dev-2"), env, db, product, NOW + 1);
    const [row] = await rows(db);
    expect(row?.device_label).toBe("Studio Laptop");
  });

  it("logs an unusable licence as license_unusable without changing the answer", async () => {
    const { licenseId } = await seedLicenseWithKey(db, SLUG, {
      expiresAt: NOW - 1,
    });
    const license = (await getLicense(db, SLUG, licenseId))!;
    const out = await authorizeDevice(env, db, product, license, "dev-9", NOW);
    expect(out).toEqual({ error: "unauthorized" });
    expect((await rows(db)).map((r) => r.reason)).toEqual(["license_unusable"]);
  });

  it("hands the write to waitUntil instead of awaiting it", async () => {
    const { key } = await seedLicenseWithKey(db, SLUG, {
      entitlements: ONE_SEAT,
    });
    await handleActivate(activateReq(key, "dev-1"), env, db, product, NOW);

    const pending: Promise<unknown>[] = [];
    const ctx: ServiceContext = {
      req: activateReq(key, "dev-2"),
      env,
      db,
      product,
      rest: ["activate"],
      now: NOW + 1,
      hooks: NO_HOOKS,
      ingest: NO_INGEST,
      waitUntil: (p) => {
        pending.push(p);
      },
    };
    const res = await handleLicenseRoutes(ctx);
    expect(res?.status).toBe(403);
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect((await rows(db)).map((r) => r.reason)).toEqual(["device_limit"]);
  });

  it("a failed write is dropped: the device still gets its refusal", async () => {
    const { key } = await seedLicenseWithKey(db, SLUG, {
      entitlements: ONE_SEAT,
    });
    await handleActivate(activateReq(key, "dev-1"), env, db, product, NOW);
    await db.run("DROP TABLE license_refusals");
    const res = await handleActivate(
      activateReq(key, "dev-2"),
      env,
      db,
      product,
      NOW + 1,
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe(
      "device_limit",
    );
  });

  it("folds repeats of one device and reason inside a minute into one row", async () => {
    const { key } = await seedLicenseWithKey(db, SLUG, {
      entitlements: ONE_SEAT,
    });
    await handleActivate(activateReq(key, "dev-1"), env, db, product, NOW);
    for (const dt of [1, 10, 59, 60]) {
      await handleActivate(
        activateReq(key, "dev-2"),
        env,
        db,
        product,
        NOW + dt,
      );
    }
    await handleActivate(activateReq(key, "dev-3"), env, db, product, NOW + 2);
    await handleActivate(activateReq(key, "dev-2"), env, db, product, NOW + 62);
    expect((await rows(db)).map((r) => r.at)).toEqual([
      NOW + 1,
      NOW + 2,
      NOW + 62,
    ]);
  });
});

describe("refusal labels are plain text", () => {
  it("strips control and format characters and cuts to the limit", () => {
    expect(sanitizeRefusalLabel("a\u0000b​c\nd")).toBe("a b c d");
    expect(sanitizeRefusalLabel("   ")).toBeNull();
    expect(sanitizeRefusalLabel(null)).toBeNull();
    expect(Array.from(sanitizeRefusalLabel("é".repeat(100))!).length).toBe(
      REFUSAL_LABEL_MAX,
    );
  });

  it("falls back to the User-Agent when no platform is reported", async () => {
    const db = makeTestDb();
    await seedProduct(db, SLUG);
    await recordRefusal(db, {
      product: SLUG,
      licenseId: "lic_1",
      deviceId: "d",
      reason: "device_limit",
      at: NOW,
      userAgent: "Godot/4.3 " + "x".repeat(200),
    });
    const [row] = await rows(db);
    expect(row?.device_label?.startsWith("Godot/4.3 x")).toBe(true);
    expect(row?.device_label?.length).toBe(REFUSAL_LABEL_MAX);
  });
});

describe("the nightly sweep prunes the refusal log", () => {
  it("deletes rows past 30 days, per product, and keeps the rest", async () => {
    const db = makeTestDb();
    await seedProduct(db, SLUG);
    await seedProduct(db, "other");
    const base = { licenseId: "lic_1", reason: "device_limit" as const };
    const now = NOW + REFUSAL_RETENTION_SECONDS + 1000;
    await logRefusal(db, { ...base, product: SLUG, deviceId: "a", at: NOW });
    await logRefusal(db, { ...base, product: "other", deviceId: "b", at: NOW });
    await logRefusal(db, {
      ...base,
      product: SLUG,
      deviceId: "c",
      at: now - 60,
    });
    const report = await runScheduledMaintenance(db, now);
    expect(report.counts[`refusals:${SLUG}`]).toBe(1);
    expect(report.counts["refusals:other"]).toBe(1);
    expect((await rows(db)).map((r) => r.at)).toEqual([now - 60]);
    // Idempotent: a second tick on the same clock removes nothing.
    const again = await runScheduledMaintenance(db, now);
    expect(again.counts[`refusals:${SLUG}`]).toBe(0);
  });
});

describe("GET /manage/api/products/<slug>/refusals", () => {
  const PLATFORM_GROUP = "platform-admins";

  async function world() {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), [SLUG]);
    env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
    env.PLATFORM_ADMIN_GROUP = PLATFORM_GROUP;
    await seedProduct(db, SLUG);
    await seedProduct(db, "other");
    const { token, session } = await issueSession(
      env,
      { sub: "u1", name: "Ada", email: "ada@x.io", groups: [PLATFORM_GROUP] },
      NOW,
    );
    const call = (method: string, path: string): Promise<Response> => {
      const headers: Record<string, string> = {
        cookie: `${ADMIN_COOKIE}=${token}`,
        [CSRF_HEADER]: session.csrf,
      };
      return handleAdmin(
        new Request(`https://key.plrs.im/manage${path}`, {
          method,
          headers,
        }) as unknown as Request,
        env,
        db,
        path.split("?")[0]!,
        { now: NOW },
      );
    };
    const log = (
      product: string,
      licenseId: string,
      deviceId: string,
      at: number,
    ) =>
      logRefusal(db, {
        product,
        licenseId,
        deviceId,
        reason: "device_limit",
        at,
        platform: "windows",
      });
    return { db, call, log };
  }

  it("answers recent refusals and the refusing licences, product-scoped", async () => {
    const { call, log } = await world();
    const DAY = 86400;
    await log(SLUG, "lic_1", "a", NOW - 2 * DAY);
    await log(SLUG, "lic_1", "b", NOW - DAY);
    await log(SLUG, "lic_2", "c", NOW - 100);
    await log(SLUG, "lic_3", "d", NOW - 8 * DAY); // outside the 7-day default
    await log("other", "lic_9", "e", NOW - 50); // another product

    const res = await call("GET", `/api/products/${SLUG}/refusals`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      since: number;
      refusals: { licenseId: string; at: number; deviceLabel: string }[];
      licenses: {
        licenseId: string;
        count: number;
        devices: number;
        lastAt: number;
      }[];
    };
    expect(body.since).toBe(NOW - 7 * DAY);
    expect(body.refusals.map((r) => r.licenseId)).toEqual([
      "lic_2",
      "lic_1",
      "lic_1",
    ]);
    expect(body.refusals[0]?.deviceLabel).toBe("windows");
    expect(body.licenses).toEqual([
      { licenseId: "lic_2", count: 1, devices: 1, lastAt: NOW - 100 },
      { licenseId: "lic_1", count: 2, devices: 2, lastAt: NOW - DAY },
    ]);
  });

  it("filters by licence and by refusedSince, and limits", async () => {
    const { call, log } = await world();
    await log(SLUG, "lic_1", "a", NOW - 300);
    await log(SLUG, "lic_1", "b", NOW - 200);
    await log(SLUG, "lic_2", "c", NOW - 100);

    const one = (await (
      await call(
        "GET",
        `/api/products/${SLUG}/refusals?licenseId=lic_1&limit=1`,
      )
    ).json()) as {
      refusals: { at: number }[];
      licenses: { licenseId: string; count: number }[];
    };
    expect(one.refusals.map((r) => r.at)).toEqual([NOW - 200]);
    expect(one.licenses).toEqual([
      expect.objectContaining({ licenseId: "lic_1", count: 2 }),
    ]);

    const since = (await (
      await call(
        "GET",
        `/api/products/${SLUG}/refusals?refusedSince=${NOW - 150}`,
      )
    ).json()) as { refusals: { licenseId: string }[] };
    expect(since.refusals.map((r) => r.licenseId)).toEqual(["lic_2"]);
  });

  it("clamps refusedSince to the retention window and rejects bad filters", async () => {
    const { call } = await world();
    const clamped = (await (
      await call("GET", `/api/products/${SLUG}/refusals?refusedSince=0`)
    ).json()) as { since: number };
    expect(clamped.since).toBe(NOW - REFUSAL_RETENTION_SECONDS);

    const bad = await call(
      "GET",
      `/api/products/${SLUG}/refusals?refusedSince=x&limit=0`,
    );
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { fields: string[] }).fields).toEqual([
      "refusedSince",
      "limit",
    ]);
  });

  it("is read-only and has no sub-resources", async () => {
    const { call } = await world();
    expect((await call("POST", `/api/products/${SLUG}/refusals`)).status).toBe(
      405,
    );
    expect(
      (await call("GET", `/api/products/${SLUG}/refusals/extra`)).status,
    ).toBe(404);
  });
});
