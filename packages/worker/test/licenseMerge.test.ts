/**
 * LX-03 (notes/S-19 §4.3 G6): a licence merge carries what the retired licence held, and the
 * device move is seat-checked.
 *
 *   - `moveDevices` / `planDeviceMove` (`repo.ts`): refuses beyond the destination's seats,
 *     otherwise gives every moved authorized device a free ordinal of the destination.
 *   - `mergeLicenseInto` + every service's `licenseMerge` (`core/licenseMerge.ts`): the retired
 *     licence's store grants and purchases move to the survivor, and its purchase binding keeps
 *     resolving as an alias, so a restore that names it reaches the survivor. Driven through the
 *     commerce bridge's real routes (`commerceWorld.ts`).
 */

import { storeGrantDrift } from "../src/core/grants.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { NOW, seedLicenseWithKey, seedProduct, seedTier } from "./seed.js";
import type { SqliteDb } from "../src/db/sqlite.js";
import {
  moveDevices,
  SEAT_DORMANCY_SECONDS,
  setDeviceStatus,
} from "../src/repo.js";
import {
  licenseMergeFor,
  licenseMergeStatements,
  mergeLicenseInto,
} from "../src/core/licenseMerge.js";
import { SERVICES } from "../src/mount.js";
import { SLUG } from "./releaseRoutesFixture.js";
import {
  FLAG,
  bindingOf,
  commerceWorld,
  grants,
  route,
  type CommerceWorld,
} from "./commerceWorld.js";

async function device(
  db: SqliteDb,
  id: string,
  licenseId: string,
  opts: { seat?: number | null; lastSeen?: number; status?: string } = {},
): Promise<void> {
  const seen = opts.lastSeen ?? NOW;
  await db.run(
    `INSERT INTO devices (product, device_id, license_id, status, seat_no, first_seen, last_seen)
     VALUES ('djdl', ?, ?, ?, ?, ?, ?)`,
    id,
    licenseId,
    opts.status ?? "authorized",
    opts.seat ?? null,
    seen,
    seen,
  );
}

async function devices(
  db: SqliteDb,
  licenseId: string,
): Promise<Array<{ device_id: string; seat_no: number | null }>> {
  return db.all(
    "SELECT device_id, seat_no FROM devices WHERE product = 'djdl' AND license_id = ? ORDER BY device_id",
    licenseId,
  );
}

describe("moveDevices is seat-checked (LX-03)", () => {
  let db: SqliteDb;
  beforeEach(async () => {
    db = makeTestDb();
    await seedProduct(db, "djdl");
    await seedTier(db, "djdl", "pro", { deviceLimit: 3 });
    await seedLicenseWithKey(db, "djdl", { id: "lic_from" });
    await seedLicenseWithKey(db, "djdl", { id: "lic_to" });
  });

  it("refuses beyond the target's seats and moves nothing", async () => {
    await device(db, "to-1", "lic_to", { seat: 1 });
    await device(db, "from-1", "lic_from", { seat: 1 });
    await device(db, "from-2", "lic_from", { seat: 2 });
    // 1 held + 2 moving > 2.
    expect(await moveDevices(db, "djdl", "lic_from", "lic_to", 2, NOW)).toBe(
      false,
    );
    expect(await devices(db, "lic_from")).toHaveLength(2);
    expect(await devices(db, "lic_to")).toEqual([
      { device_id: "to-1", seat_no: 1 },
    ]);
    // A non-positive limit denies, as `claimDeviceSeat`'s does.
    expect(await moveDevices(db, "djdl", "lic_from", "lic_to", 0, NOW)).toBe(
      false,
    );
  });

  it("counts a dormant device on the source (it moves too), not a dormant one on the target", async () => {
    const dormant = NOW - SEAT_DORMANCY_SECONDS - 86400;
    await device(db, "to-old", "lic_to", { seat: 1, lastSeen: dormant });
    await device(db, "from-old", "lic_from", { lastSeen: dormant });
    await device(db, "from-1", "lic_from", { seat: 1 });
    // The target's dormant seat is released, so both moving devices fit two seats…
    expect(await moveDevices(db, "djdl", "lic_from", "lic_to", 2, NOW)).toBe(
      true,
    );
    // …and each takes an ordinal of the target, the target's dormant device none.
    expect(await devices(db, "lic_to")).toEqual([
      { device_id: "from-1", seat_no: 2 },
      { device_id: "from-old", seat_no: 1 },
      { device_id: "to-old", seat_no: null },
    ]);
  });

  it("gives every moved authorized device a free ordinal of the target, and carries a deauthorized one without", async () => {
    await device(db, "to-1", "lic_to", { seat: 2 });
    await device(db, "from-1", "lic_from", { seat: 1 });
    await device(db, "from-2", "lic_from", { seat: 2 });
    await device(db, "from-gone", "lic_from", { status: "authorized" });
    await setDeviceStatus(db, "djdl", "from-gone", "deauthorized");
    expect(await moveDevices(db, "djdl", "lic_from", "lic_to", 3, NOW)).toBe(
      true,
    );
    expect(await devices(db, "lic_from")).toEqual([]);
    expect(await devices(db, "lic_to")).toEqual([
      { device_id: "from-1", seat_no: 1 },
      { device_id: "from-2", seat_no: 3 },
      { device_id: "from-gone", seat_no: null },
      { device_id: "to-1", seat_no: 2 },
    ]);
  });
});

describe("a licence merge carries store grants, purchases and the binding (LX-03)", () => {
  let w: CommerceWorld | null = null;
  afterEach(async () => {
    // LX-08: the merge moves the purchases' grants with their store-grant rows (zero drift).
    if (w) expect(await storeGrantDrift(w.db, SLUG)).toEqual([]);
    w?.close();
    w = null;
  });

  const claim = (cw: CommerceWorld, token: string, signedTransaction: string) =>
    route(cw, "POST", "/distribution/commerce/claim", {
      token,
      body: { store: "app-store", signedTransaction },
    });

  async function boughtWith(
    cw: CommerceWorld,
    binding: string,
    transactionId: string,
  ): Promise<string> {
    const tx = { transactionId, appAccountToken: binding };
    cw.fakes.apple.transactions.set(transactionId, tx);
    return cw.fakes.apple.signTransaction(tx, NOW - 60);
  }

  async function merge(cw: CommerceWorld): Promise<void> {
    expect(
      await mergeLicenseInto(
        cw.db,
        licenseMergeFor(SERVICES),
        {
          product: SLUG,
          fromLicenseId: cw.licenseA,
          toLicenseId: cw.licenseB,
          now: cw.now,
        },
        10,
        [],
      ),
    ).toBe("merged");
  }

  it("after migrate, a restore on the old binding reaches the target licence", async () => {
    const cw = (w = await commerceWorld());
    const oldBinding = await bindingOf(cw, cw.tokenA);
    const targetBinding = await bindingOf(cw, cw.tokenB);
    // One purchase restored on licence A before the merge, one made under A's binding and not
    // yet restored when the merge happens.
    const restored = await boughtWith(cw, oldBinding, "2000000301");
    const pending = await boughtWith(cw, oldBinding, "2000000302");
    expect((await claim(cw, cw.tokenA, restored)).status).toBe(200);
    expect(await grants(cw, cw.licenseA)).toEqual([`app-store:${FLAG}`]);
    // Before the merge, licence B cannot restore under A's binding.
    expect(
      (
        (await (await claim(cw, cw.tokenB, pending)).json()) as {
          reason: string;
        }
      ).reason,
    ).toBe("binding_mismatch");

    await merge(cw);

    // The grant moved with its purchase; A's device is on B.
    expect(await grants(cw, cw.licenseA)).toEqual([]);
    expect(await grants(cw, cw.licenseB)).toEqual([`app-store:${FLAG}`]);
    expect(
      (
        await cw.db.first<{ license_id: string }>(
          "SELECT license_id FROM devices WHERE product = ? AND device_id = 'dev-a'",
          SLUG,
        )
      )?.license_id,
    ).toBe(cw.licenseB);

    // The restored purchase is now B's ("first licence wins" names the survivor)…
    const again = await claim(cw, cw.tokenB, restored);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ granted: true, changed: false });
    // …and the purchase made under the OLD binding restores onto B.
    const late = await claim(cw, cw.tokenB, pending);
    expect(late.status).toBe(200);
    expect(await late.json()).toMatchObject({ granted: true, changed: true });
    const rows = await cw.db.all<{ license_id: string }>(
      "SELECT license_id FROM license_store_grants WHERE product = ? AND state = 'active'",
      SLUG,
    );
    expect(rows.map((r) => r.license_id)).toEqual([cw.licenseB, cw.licenseB]);
    // B keeps its own binding for new purchases; A's binding row is kept, aliased to B.
    expect(await bindingOf(cw, cw.tokenB)).toBe(targetBinding);
    expect(
      await cw.db.first(
        "SELECT binding_id, license_id, from_license_id FROM dist_purchase_binding_aliases WHERE product = ?",
        SLUG,
      ),
    ).toEqual({
      binding_id: oldBinding,
      license_id: cw.licenseB,
      from_license_id: cw.licenseA,
    });
    expect(
      await cw.db.first(
        "SELECT license_id FROM dist_purchase_bindings WHERE product = ? AND binding_id = ?",
        SLUG,
        oldBinding,
      ),
    ).toEqual({ license_id: cw.licenseA });
  });

  it("a merge of the survivor re-points its aliases, so a chain resolves to the last licence", async () => {
    const cw = (w = await commerceWorld());
    const oldBinding = await bindingOf(cw, cw.tokenA);
    await merge(cw);
    await seedLicenseWithKey(cw.db, SLUG, { id: "lic_c" });
    const statements = licenseMergeStatements(SERVICES, {
      product: SLUG,
      fromLicenseId: cw.licenseB,
      toLicenseId: "lic_c",
      now: cw.now,
    });
    await cw.db.batch(statements);
    const alias = await cw.db.first<{ license_id: string }>(
      "SELECT license_id FROM dist_purchase_binding_aliases WHERE product = ? AND binding_id = ?",
      SLUG,
      oldBinding,
    );
    expect(alias?.license_id).toBe("lic_c");
  });

  it("License and Distribution contribute whatever their enablement; a merge onto itself contributes nothing", () => {
    const change = {
      product: SLUG,
      fromLicenseId: "lic_x",
      toLicenseId: "lic_y",
      now: NOW,
    };
    const sql = licenseMergeStatements(SERVICES, change).map((s) => s.sql);
    expect(sql.some((s) => s.includes("license_store_grants"))).toBe(true);
    expect(sql.some((s) => s.includes("dist_purchases"))).toBe(true);
    expect(sql.some((s) => s.includes("dist_purchase_binding_aliases"))).toBe(
      true,
    );
    expect(
      licenseMergeStatements(SERVICES, { ...change, toLicenseId: "lic_x" }),
    ).toEqual([]);
  });
});
