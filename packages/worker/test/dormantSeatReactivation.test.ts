// B-158: a dormant device that comes back must claim a seat like any new device, and be refused
// with `device_limit` when the licence has filled meanwhile; it must never hold a live token
// with no seat while others fill the licence.

import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import {
  makeEnv,
  mkReq,
  NOW,
  seedKeyForLicense,
  seedLicenseWithKey,
  seedProduct,
  seedTier,
} from "./seed.js";
import type { SqliteDb } from "../src/db/sqlite.js";
import type { Env } from "../src/platform/env.js";
import { loadProduct, type Product } from "../src/core/products.js";
import { handleActivate } from "../src/services/license/activation.js";
import {
  countActiveDevices,
  SEAT_DORMANCY_SECONDS,
  seatActiveSince,
} from "../src/core/devices/store.js";

describe("dormant device re-activation (B-158)", () => {
  let db: SqliteDb;
  let env: Env;
  let product: Product;
  let licenseId: string;

  beforeEach(async () => {
    db = makeTestDb();
    env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    await seedTier(db, "djdl", "pro", { deviceLimit: 2 });
    const seeded = await seedLicenseWithKey(db, "djdl", { tierId: "pro" });
    licenseId = seeded.licenseId;
    product = (await loadProduct(env, db, "djdl"))!;
  });

  async function activate(device: string, now: number): Promise<Response> {
    const k = await seedKeyForLicense(db, "djdl", licenseId);
    return handleActivate(
      mkReq("POST", { authorization: `Bearer ${k}`, "x-pkey-device": device }),
      env,
      db,
      product,
      now,
    );
  }

  it("is refused when the licence filled while it was away, and holds no token", async () => {
    expect((await activate("old-1", NOW)).status).toBe(200);
    const later = NOW + SEAT_DORMANCY_SECONDS + 3600;
    // Two new devices fill the licence; old-1's seat is reclaimed.
    expect((await activate("new-1", later)).status).toBe(200);
    expect((await activate("new-2", later)).status).toBe(200);
    // old-1 returns: no seat is free.
    const back = await activate("old-1", later + 10);
    expect(back.status).not.toBe(200);
    const live = await countActiveDevices(
      db,
      "djdl",
      licenseId,
      seatActiveSince(later + 10),
    );
    expect(live).toBe(2);
    const row = await db.first<{
      seat_no: number | null;
      token_hash: string | null;
    }>(
      "SELECT seat_no, token_hash FROM devices WHERE product='djdl' AND device_id='old-1'",
    );
    expect(row?.token_hash).toBeNull();
  });

  it("re-claims a free seat and holds an ordinal", async () => {
    expect((await activate("old-1", NOW)).status).toBe(200);
    const later = NOW + SEAT_DORMANCY_SECONDS + 3600;
    expect((await activate("new-1", later)).status).toBe(200);
    const back = await activate("old-1", later + 10);
    expect(back.status).toBe(200);
    const row = await db.first<{ seat_no: number | null }>(
      "SELECT seat_no FROM devices WHERE product='djdl' AND device_id='old-1'",
    );
    expect(row?.seat_no).not.toBeNull();
  });
});
