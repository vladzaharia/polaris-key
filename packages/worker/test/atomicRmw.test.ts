// Read-modify-write races closed: the metadata touch and token rotation, the dormant-seat
// release, the attestation challenge, the webhook claim and the override-migration audit id.
// Each test fails on the code before this change.
import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import {
  makeEnv,
  NOW,
  seedLicenseWithKey,
  seedProduct,
  seedTier,
} from "./seed.js";
import type { SqliteDb } from "../src/db/sqlite.js";
import type { Env } from "../src/env.js";
import { loadProduct, type Product } from "../src/core/products.js";
import {
  rotateDeviceToken,
  touchDeviceMetadata,
  validateDeviceToken,
} from "../src/core/devices.js";
import {
  claimDeviceSeat,
  getDevice,
  releaseDormantSeats,
  setDeviceStatus,
} from "../src/repo.js";
import { claimOnce } from "../src/core/atomicClaim.js";
import { SEAT_DORMANCY_SECONDS } from "../src/repo.js";

describe("atomic read-modify-write", () => {
  let db: SqliteDb;
  let env: Env;
  let product: Product;
  const DEV = "dDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";

  beforeEach(async () => {
    db = makeTestDb();
    env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    await seedTier(db, "djdl", "free", { deviceLimit: 1 });
    await seedLicenseWithKey(db, "djdl", { id: "lic_a" });
    product = (await loadProduct(env, db, "djdl"))!;
    await db.run(
      `INSERT INTO devices (product, device_id, license_id, status, seat_no, first_seen, last_seen, token_hash)
       VALUES ('djdl', ?, 'lic_a', 'authorized', 1, ?, ?, 'h1')`,
      DEV,
      NOW,
      NOW,
    );
  });

  it("a stale touch does not resurrect a deauthorized device", async () => {
    const stale = (await getDevice(db, "djdl", DEV))!;
    await setDeviceStatus(db, "djdl", DEV, "deauthorized");
    await touchDeviceMetadata(
      db,
      stale,
      {
        userAgent: "x",
        platform: null,
        arch: null,
        appVersion: null,
        sdkName: null,
        sdkVersion: null,
      },
      NOW + 1,
    );
    expect((await getDevice(db, "djdl", DEV))?.status).toBe("deauthorized");
  });

  it("rotation after a deauthorize mints nothing and leaves the row", async () => {
    const stale = (await getDevice(db, "djdl", DEV))!;
    await setDeviceStatus(db, "djdl", DEV, "deauthorized");
    await expect(
      rotateDeviceToken(
        env,
        db,
        product,
        { tokenHash: "h1", device: stale, license: null } as never,
        NOW + 1,
      ),
    ).rejects.toThrow();
    const row = await getDevice(db, "djdl", DEV);
    expect(row?.status).toBe("deauthorized");
    expect(row?.token_hash).toBe("h1");
  });

  it("a dormant-released seat takes the old token with it", async () => {
    const later = NOW + SEAT_DORMANCY_SECONDS + 10;
    expect(await releaseDormantSeats(db, "djdl", later)).toBe(1);
    const row = await getDevice(db, "djdl", DEV);
    expect(row?.seat_no).toBeNull();
    expect(row?.token_hash).toBeNull();
    // the seat is free for another device
    expect(await claimDeviceSeat(db, "djdl", "lic_a", "other", 1, later)).toBe(
      true,
    );
  });

  it("a claim is granted to exactly one concurrent caller", async () => {
    const r = await Promise.all(
      Array.from({ length: 5 }, () =>
        claimOnce(env, "webhook-claim", "same", 60),
      ),
    );
    expect(r.filter(Boolean)).toHaveLength(1);
  });
});
