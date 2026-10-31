/// <reference types="@cloudflare/workers-types" />
// ── The owned-licence guard on the seat claim, in D1 (CORE-SEAT-GUARD) ──────────────────────
//
// `claimDeviceSeat` with `refuseOwnedLicense` writes its seat as `INSERT … SELECT … WHERE NOT
// EXISTS (…) ON CONFLICT … DO UPDATE … WHERE … AND NOT EXISTS (…)`, and the key entry beside it
// carries the same guard. The Node lane proves the behaviour on better-sqlite3; this proves D1
// parses and applies the same statements, in a real batch.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import djdlCatalog from "../../../products/djdl/catalog.json";
import { D1Db } from "../src/db/d1.js";
import { claimDeviceSeat } from "../src/core/devices/store.js";
import { stmtRecordDeviceKeyEntry } from "../src/core/licensing/keyEntries.js";
import { NOW, seedLicenseWithKey, seedProduct } from "./seed.js";

const SLUG = "seatguard";

describe("D1 applies the owned-licence guard at the seat claim", () => {
  it("seats and counts an unowned licence, and neither once the licence has an account", async () => {
    const db = new D1Db(env.DB);
    await seedProduct(env, db, SLUG, djdlCatalog);
    const { licenseId } = await seedLicenseWithKey(db, SLUG);
    const claim = (device: string) =>
      claimDeviceSeat(db, SLUG, licenseId, device, 5, NOW, {
        refuseOwnedLicense: true,
        withClaim: () =>
          stmtRecordDeviceKeyEntry(SLUG, licenseId, device, "app", NOW, true),
      });
    const seats = () =>
      db.all<{ device_id: string }>(
        "SELECT device_id FROM devices WHERE product = ? AND license_id = ?",
        SLUG,
        licenseId,
      );
    const entries = async () =>
      (
        await db.first<{ n: number }>(
          "SELECT COUNT(*) AS n FROM license_key_entries WHERE product = ? AND license_id = ?",
          SLUG,
          licenseId,
        )
      )?.n;

    expect(await claim("guard-1")).toBe(true);
    expect(await seats()).toEqual([{ device_id: "guard-1" }]);
    expect(await entries()).toBe(1);

    await db.run(
      "UPDATE licenses SET account_id = 'acct_guard' WHERE product = ? AND id = ?",
      SLUG,
      licenseId,
    );
    expect(await claim("guard-2")).toBe(false);
    expect(await seats()).toEqual([{ device_id: "guard-1" }]);
    expect(await entries()).toBe(1);
  });
});
