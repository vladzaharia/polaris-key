// SEC-WP-01: a device id is client-claimed and the `devices` row is keyed (product, device_id), so
// a row held live by one licence must never be rebound, evicted or inherited by another
// (SEC-LIC-1, SEC-LIC-2, SEC-LIC-9, SEC-LIC-10, SEC-IDN-5, SEC-CLI-18). Each test fails on the
// code before this change; see the work-package report for the failing-on-old evidence.

import { beforeEach, describe, expect, it } from "vitest";
import { FINGERPRINT_COMPONENT_LENGTH } from "@polaris-key/protocol";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import {
  makeEnv,
  mkReq,
  NOW,
  seedLicenseWithKey,
  seedProduct,
  seedTier,
} from "./seed.js";
import type { SqliteDb } from "../src/db/sqlite.js";
import type { Env } from "../src/env.js";
import { loadProduct, type Product } from "../src/core/products.js";
import { handleEnroll } from "../src/services/license/enroll.js";
import {
  handleActivate,
  handleToken,
} from "../src/services/license/activation.js";
import { validateDeviceToken } from "../src/core/devices.js";
import {
  claimDeviceSeat,
  getDevice,
  listAudit,
  setDeviceStatus,
} from "../src/repo.js";

function hash(seed: string): string {
  return seed
    .padEnd(FINGERPRINT_COMPONENT_LENGTH, "x")
    .slice(0, FINGERPRINT_COMPONENT_LENGTH);
}
const machine = (tag: string) => ({
  machineUuid: hash(`uuid${tag}`),
  boardSerial: hash(`board${tag}`),
  cpuModel: hash(`cpu${tag}`),
});
const VICTIM_HW = machine("V");
const ATTACKER_HW = machine("A");

/** Server-derived ids are 32 base64url characters; use that shape for the victim's device. */
const VICTIM_DEVICE = "vVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV";

describe("device-id ownership (SEC-WP-01)", () => {
  let db: SqliteDb;
  let env: Env;
  let product: Product;
  let victim: { licenseId: string; key: string };
  let attacker: { licenseId: string; key: string };

  beforeEach(async () => {
    db = makeTestDb();
    env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    await seedTier(db, "djdl", "free", { deviceLimit: 2 });
    await db.run(
      "UPDATE products SET auto_issue_json = ? WHERE slug = ?",
      JSON.stringify({
        enabled: true,
        tierId: "free",
        mode: "anonymous",
        rateLimitPerHour: 100,
      }),
      "djdl",
    );
    product = (await loadProduct(env, db, "djdl"))!;
    victim = await seedLicenseWithKey(db, "djdl", { id: "lic_victim" });
    attacker = await seedLicenseWithKey(db, "djdl", { id: "lic_attacker" });
  });

  function activate(
    key: string,
    device: string,
    components?: Record<string, string>,
  ): Promise<Response> {
    return handleActivate(
      mkReq(
        "POST",
        { authorization: `Bearer ${key}`, "x-pkey-device": device },
        components ? { fingerprint: { components } } : undefined,
      ),
      env,
      db,
      product,
      NOW,
    );
  }
  function enroll(
    device: string,
    components: Record<string, string>,
  ): Promise<Response> {
    return handleEnroll(
      mkReq(
        "POST",
        { "x-pkey-device": device },
        {
          fingerprint: { components },
        },
      ),
      env,
      db,
      product,
      NOW,
    );
  }

  async function victimActivates(): Promise<string> {
    const res = await activate(victim.key, VICTIM_DEVICE, VICTIM_HW);
    expect(res.status).toBe(200);
    return ((await res.json()) as { token: string }).token;
  }
  async function tokenStillValid(token: string): Promise<boolean> {
    const v = await validateDeviceToken(env, db, product, token, NOW, {
      deviceId: VICTIM_DEVICE,
    });
    return !("error" in v);
  }
  async function expectVictimIntact(token: string): Promise<void> {
    const row = await getDevice(db, "djdl", VICTIM_DEVICE);
    expect(row?.license_id).toBe(victim.licenseId);
    expect(row?.status).toBe("authorized");
    expect(row?.seat_no).not.toBeNull();
    expect(await tokenStillValid(token)).toBe(true);
  }

  describe("SEC-LIC-1 / SEC-CLI-18: activate with a held device id", () => {
    it("refuses an attacker licence presenting its own fingerprint, and leaves the victim bound", async () => {
      const token = await victimActivates();
      const res = await activate(attacker.key, VICTIM_DEVICE, ATTACKER_HW);
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: "unauthorized" });
      await expectVictimIntact(token);
    });

    it("refuses an attacker presenting no fingerprint at all", async () => {
      const token = await victimActivates();
      expect((await activate(attacker.key, VICTIM_DEVICE)).status).toBe(401);
      await expectVictimIntact(token);
    });

    it("does not let a forged anchor with other components differing pass as the victim's machine", async () => {
      const token = await victimActivates();
      const forged = { ...ATTACKER_HW, machineUuid: VICTIM_HW.machineUuid };
      // Anchor matches but both other components differ: beyond `normal` tolerance.
      expect((await activate(attacker.key, VICTIM_DEVICE, forged)).status).toBe(
        401,
      );
      await expectVictimIntact(token);
    });

    it("answers a non-owner's mismatch with no component detail and does not retire the binding (SEC-LIC-10)", async () => {
      const token = await victimActivates();
      const res = await activate(attacker.key, VICTIM_DEVICE, {
        machineUuid: hash("other"),
        boardSerial: hash("other"),
        cpuModel: hash("other"),
      });
      const body = await res.text();
      expect(res.status).toBe(401);
      expect(body).not.toMatch(/changed|drift|hardware_mismatch/);
      await expectVictimIntact(token);
    });

    it("answers a refused key and a held device id identically", async () => {
      await victimActivates();
      const held = await activate(attacker.key, VICTIM_DEVICE, ATTACKER_HW);
      const bad = await activate(
        "pk_djdl_nokey",
        "someotherdevice",
        ATTACKER_HW,
      );
      expect(held.status).toBe(bad.status);
      expect(await held.json()).toEqual(await bad.json());
    });

    it("never writes a seat or row for the attacker's licence", async () => {
      await victimActivates();
      await activate(attacker.key, VICTIM_DEVICE, ATTACKER_HW);
      const rows = await db.all(
        "SELECT device_id FROM devices WHERE product = ? AND license_id = ?",
        "djdl",
        attacker.licenseId,
      );
      expect(rows).toHaveLength(0);
      const audit = await listAudit(db, "djdl", { limit: 50 });
      expect(
        audit.some(
          (a) =>
            a.action === "device.claim.refused" &&
            a.parent_id === attacker.licenseId,
        ),
      ).toBe(true);
    });

    it("the legitimate machine can still move to another licence it holds a key for (same fingerprint)", async () => {
      const token = await victimActivates();
      const res = await activate(attacker.key, VICTIM_DEVICE, VICTIM_HW);
      expect(res.status).toBe(200);
      const row = await getDevice(db, "djdl", VICTIM_DEVICE);
      expect(row?.license_id).toBe(attacker.licenseId);
      // The old credential died with the move; the new one is the one in force.
      expect(await tokenStillValid(token)).toBe(false);
    });

    it("concurrent attackers against one held id: both refused, victim intact", async () => {
      const token = await victimActivates();
      const second = await seedLicenseWithKey(db, "djdl", { id: "lic_two" });
      const [a, b, c] = await Promise.all([
        activate(attacker.key, VICTIM_DEVICE, ATTACKER_HW),
        activate(second.key, VICTIM_DEVICE, machine("B")),
        activate(attacker.key, VICTIM_DEVICE),
      ]);
      expect([a.status, b.status, c.status]).toEqual([401, 401, 401]);
      await expectVictimIntact(token);
    });

    it("the seat claim itself will not move a row that changed hands after the check", async () => {
      const token = await victimActivates();
      // A claimant that believed the row was held by some OTHER licence (stale observation).
      const ok = await claimDeviceSeat(
        db,
        "djdl",
        attacker.licenseId,
        VICTIM_DEVICE,
        2,
        NOW,
        { adoptFrom: "lic_somebody_else" },
      );
      expect(ok).toBe(false);
      await expectVictimIntact(token);
      // And with no adoptFrom at all, a held foreign row is never taken.
      expect(
        await claimDeviceSeat(
          db,
          "djdl",
          attacker.licenseId,
          VICTIM_DEVICE,
          2,
          NOW,
        ),
      ).toBe(false);
      await expectVictimIntact(token);
    });
  });

  describe("SEC-LIC-1 / SEC-LIC-10: enroll with a held device id (keyless eviction)", () => {
    it("refuses an anonymous enrol naming the victim's device id", async () => {
      const token = await victimActivates();
      const res = await enroll(VICTIM_DEVICE, ATTACKER_HW);
      expect(res.status).toBe(401);
      await expectVictimIntact(token);
    });

    it("concurrent anonymous enrols against a held id never move the row", async () => {
      const token = await victimActivates();
      const rs = await Promise.all(
        [machine("1"), machine("2"), machine("3")].map((m) =>
          enroll(VICTIM_DEVICE, m),
        ),
      );
      expect(rs.map((r) => r.status)).toEqual([401, 401, 401]);
      await expectVictimIntact(token);
    });

    it("a machine that enrolled free can still activate a purchased key (same fingerprint)", async () => {
      const first = await enroll(
        "freedevice00000000000000000000001",
        VICTIM_HW,
      );
      expect(first.status).toBe(200);
      const res = await activate(
        victim.key,
        "freedevice00000000000000000000001",
        VICTIM_HW,
      );
      expect(res.status).toBe(200);
    });
  });

  describe("SEC-LIC-2: a row changing licence carries nothing of the old one", () => {
    async function dress(): Promise<void> {
      await db.run(
        `UPDATE devices SET label = 'Ada laptop', overrides_json = ?, reported_json = ?
          WHERE product = ? AND device_id = ?`,
        JSON.stringify({ entitlements: { comped: { value: true } } }),
        JSON.stringify({ k: "v" }),
        "djdl",
        VICTIM_DEVICE,
      );
    }
    async function clean(): Promise<void> {
      const row = await getDevice(db, "djdl", VICTIM_DEVICE);
      expect(row?.license_id).toBe(attacker.licenseId);
      expect(row?.overrides_json).toBeNull();
      expect(row?.reported_json).toBeNull();
      expect(row?.label).toBeNull();
    }

    it("adopting a deauthorized row clears overrides, label and reported data", async () => {
      await victimActivates();
      await dress();
      await setDeviceStatus(db, "djdl", VICTIM_DEVICE, "deauthorized");
      expect(
        (await activate(attacker.key, VICTIM_DEVICE, ATTACKER_HW)).status,
      ).toBe(200);
      await clean();
    });

    it("a proven move between licences also starts clean", async () => {
      await victimActivates();
      await dress();
      expect(
        (await activate(attacker.key, VICTIM_DEVICE, VICTIM_HW)).status,
      ).toBe(200);
      await clean();
    });
  });

  describe("SEC-LIC-9 / SEC-IDN-5: client-claimed device ids are validated", () => {
    const bad = [
      "x".repeat(129),
      "browser:lic_victim",
      "=cmd|' /C calc'!A0",
      "has space",
      "tab\there",
      "ünicode",
    ];
    for (const id of bad) {
      it(`activate refuses ${JSON.stringify(id.slice(0, 24))}`, async () => {
        let res: Response;
        try {
          res = await activate(victim.key, id, VICTIM_HW);
        } catch {
          // Headers cannot carry some of these at all (fetch throws): refused earlier still.
          return;
        }
        expect(res.status).toBe(400);
      });
      it(`enroll refuses ${JSON.stringify(id.slice(0, 24))}`, async () => {
        let res: Response;
        try {
          res = await enroll(id, VICTIM_HW);
        } catch {
          return;
        }
        expect(res.status).toBe(400);
      });
    }

    it("token refuses a malformed device id before touching a token", async () => {
      const res = await handleToken(
        mkReq("POST", {
          authorization: "Bearer pkeyt_" + "a".repeat(43),
          "x-pkey-device": "browser:lic_victim",
        }),
        env,
        db,
        product,
        NOW,
      );
      expect(res.status).toBe(400);
    });

    it("a key holder cannot name the browser session's server-minted device id", async () => {
      // The browser row for the victim's licence exists (minted by the server, not a client).
      await db.run(
        `INSERT INTO devices (product, device_id, license_id, status, seat_no, first_seen, last_seen)
         VALUES ('djdl', 'browser:lic_victim', 'lic_victim', 'authorized', 1, ?, ?)`,
        NOW,
        NOW,
      );
      expect(
        (await activate(attacker.key, "browser:lic_victim", ATTACKER_HW))
          .status,
      ).toBe(400);
      const row = await getDevice(db, "djdl", "browser:lic_victim");
      expect(row?.license_id).toBe("lic_victim");
      expect(row?.seat_no).toBe(1);
    });

    it("still accepts the SDK-derived 32-character form and short legacy ids", async () => {
      expect(
        (await activate(victim.key, VICTIM_DEVICE, VICTIM_HW)).status,
      ).toBe(200);
      expect((await activate(victim.key, "dev-1", VICTIM_HW)).status).toBe(200);
    });
  });
});
