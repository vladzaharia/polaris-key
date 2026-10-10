// LX-14a: a per-licence device limit (`licenses.device_limit`, 0084).
//
// Precedence: the licence's own limit, else the tier's, else a `deviceLimit` entitlement (a
// profile, store grant or licence override), else the product default. These tests pin that the
// SAME number reaches `authorizeDevice` and the signed licence document, that `null` inherits
// again, that lowering the limit signs nobody out but refuses the next new device, that every
// change is audited old → new, and that the admin read reports the effective value and source.

import { beforeEach, describe, expect, it } from "vitest";
import { verifyJws } from "@polaris-key/jws";
import type { LicenseDoc } from "@polaris-key/protocol/license";
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
  TEST_KID,
  TEST_PUB,
} from "./seed.js";
import type { SqliteDb } from "../src/db/sqlite.js";
import type { Env } from "../src/platform/env.js";
import { loadProduct, type Product } from "../src/core/products.js";
import {
  licenseDeviceLimit,
  licenseDeviceLimitInfo,
} from "../src/core/licensing/authz.js";
import { handleActivate } from "../src/services/license/activation.js";
import { handleLicenseDocument } from "../src/services/license/document.js";
import { handleAdmin } from "../src/console/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/core/console/session.js";
import {
  claimEnrolledLicense,
  getLicense,
  listAudit,
  SEAT_DORMANCY_SECONDS,
} from "../src/core/repo.js";

const TRUST = { [TEST_KID]: TEST_PUB };
const PLATFORM_GROUP = "admins";
const DEVICE = "device-fixture-01";

describe("per-licence device limit (LX-14a)", () => {
  let db: SqliteDb;
  let env: Env;
  let product: Product;
  let licenseId: string;
  let key: string;
  let token: string;

  beforeEach(async () => {
    db = makeTestDb();
    env = makeEnv(new KvMock(), ["djdl"]);
    env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
    env.PLATFORM_ADMIN_GROUP = PLATFORM_GROUP;
    await seedProduct(db, "djdl"); // product default: 5 devices
    await seedTier(db, "djdl", "pro", { deviceLimit: 3 });

    const seeded = await seedLicenseWithKey(db, "djdl", { tierId: "pro" });
    licenseId = seeded.licenseId;
    key = seeded.key;
    product = (await loadProduct(env, db, "djdl"))!;
    token = await activate(DEVICE);
  });

  async function activate(device: string): Promise<string> {
    const res = await activateRes(device);
    expect(res.status).toBe(200);
    return ((await res.json()) as { token: string }).token;
  }

  async function activateRes(device: string): Promise<Response> {
    const k =
      device === DEVICE ? key : await seedKeyForLicense(db, "djdl", licenseId);
    return handleActivate(
      mkReq("POST", { authorization: `Bearer ${k}`, "x-pkey-device": device }),
      env,
      db,
      product,
      NOW,
    );
  }

  async function doc(): Promise<LicenseDoc> {
    const res = await handleLicenseDocument(
      mkReq("GET", {
        authorization: `Bearer ${token}`,
        "x-pkey-device": DEVICE,
      }),
      env,
      db,
      product,
      NOW,
    );
    expect(res.status).toBe(200);
    return (await verifyJws(await res.text(), TRUST))!.payload as LicenseDoc;
  }

  async function admin(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const { token: cookieToken, session } = await issueSession(
      env,
      { sub: "u1", name: "Ada", email: "a@x.io", groups: [PLATFORM_GROUP] },
      NOW,
    );
    return handleAdmin(
      mkReq(
        method,
        {
          cookie: `${ADMIN_COOKIE}=${cookieToken}`,
          [CSRF_HEADER]: session.csrf,
          "content-type": "application/json",
        },
        body,
      ),
      env,
      db,
      `/api/products/djdl/license/licenses/${path}`,
      { now: NOW },
    );
  }

  const patch = (body: unknown) => admin("PATCH", licenseId, body);
  const read = async () =>
    (await (await admin("GET", licenseId)).json()) as Record<string, unknown>;

  it("a licence limit beats the tier for the document, the seat check and the read", async () => {
    expect((await doc()).entitlements["deviceLimit"]?.value).toBe(3);
    expect(await read()).toMatchObject({
      deviceLimit: null,
      effectiveDeviceLimit: 3,
      deviceLimitSource: "tier",
    });

    expect((await patch({ deviceLimit: 7 })).status).toBe(200);

    expect((await doc()).entitlements["deviceLimit"]).toMatchObject({
      state: "enforced",
      value: 7,
    });
    const license = (await getLicense(db, "djdl", licenseId))!;
    expect(license.device_limit).toBe(7);
    expect(await licenseDeviceLimit(db, product, license, NOW)).toBe(7);
    expect(await read()).toMatchObject({
      deviceLimit: 7,
      effectiveDeviceLimit: 7,
      deviceLimitSource: "license",
      inheritedDeviceLimit: 3,
      inheritedDeviceLimitSource: "tier",
    });
    // The list carries the same fields.
    const list = (await (await admin("GET", "")).json()) as {
      licenses: Record<string, unknown>[];
    };
    expect(list.licenses[0]).toMatchObject({
      effectiveDeviceLimit: 7,
      deviceLimitSource: "license",
    });

    // Beyond the tier's 3: the 4th device activates under the licence's 7.
    for (const d of ["device-two", "device-three", "device-four"])
      await activate(d);
  });

  it("null inherits again", async () => {
    await patch({ deviceLimit: 1 });
    expect((await doc()).entitlements["deviceLimit"]?.value).toBe(1);
    expect((await patch({ deviceLimit: null })).status).toBe(200);
    expect((await getLicense(db, "djdl", licenseId))!.device_limit).toBeNull();
    expect((await doc()).entitlements["deviceLimit"]?.value).toBe(3);
    expect(await read()).toMatchObject({
      deviceLimit: null,
      effectiveDeviceLimit: 3,
      deviceLimitSource: "tier",
    });
  });

  it("beats the product default and a deviceLimit entitlement; each source is named", async () => {
    // No tier, an override carrying a deviceLimit entitlement of 2.
    const ent = { state: "enforced" as const, value: 2, updatedAt: NOW };
    await seedLicenseWithKey(db, "djdl", {
      id: "lic_ent",
      entitlements: { deviceLimit: ent },
    });
    const withEnt = (await getLicense(db, "djdl", "lic_ent"))!;
    expect(await licenseDeviceLimitInfo(db, product, withEnt, NOW)).toEqual({
      limit: 2,
      source: "entitlement",
      inherited: { limit: 2, source: "entitlement" },
    });
    expect(
      await licenseDeviceLimitInfo(
        db,
        product,
        { ...withEnt, device_limit: 9 },
        NOW,
      ),
    ).toMatchObject({ limit: 9, source: "license" });

    await seedLicenseWithKey(db, "djdl", { id: "lic_plain" });
    const plain = (await getLicense(db, "djdl", "lic_plain"))!;
    expect(await licenseDeviceLimitInfo(db, product, plain, NOW)).toMatchObject(
      {
        limit: 5,
        source: "product",
      },
    );
    expect(
      await licenseDeviceLimit(db, product, { ...plain, device_limit: 1 }, NOW),
    ).toBe(1);
  });

  it("applies to a sign-in licence, and claiming it through sign-in keeps the column", async () => {
    await db.run(
      "UPDATE licenses SET sub = 'oidc|mara', origin = 'oidc' WHERE product = ? AND id = ?",
      "djdl",
      licenseId,
    );
    await patch({ deviceLimit: 2 });
    // OIDC sign-in's in-place rewrite (tier, holder, expiry) never touches device_limit.
    await claimEnrolledLicense(
      db,
      "djdl",
      licenseId,
      {
        sub: "oidc|mara",
        name: "Mara",
        email: "m@x.io",
        groupsJson: null,
        tierId: "pro",
        expiresAt: null,
      },
      NOW,
    );
    const license = (await getLicense(db, "djdl", licenseId))!;
    expect(license.device_limit).toBe(2);
    expect(await licenseDeviceLimit(db, product, license, NOW)).toBe(2);
    expect((await doc()).entitlements["deviceLimit"]?.value).toBe(2);
  });

  it("lowering below the active devices signs nobody out and refuses the next new device", async () => {
    await activate("device-two");
    const res = await patch({ deviceLimit: 1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      overLimit: { deviceCount: 2, deviceLimit: 1 },
    });

    const rows = await db.all<{ n: number }>(
      "SELECT COUNT(*) AS n FROM devices WHERE product = ? AND license_id = ? AND status = 'authorized'",
      "djdl",
      licenseId,
    );
    expect(rows[0]?.n).toBe(2);
    // An existing device is still served.
    expect((await doc()).entitlements["deviceLimit"]?.value).toBe(1);

    const refused = await activateRes("device-three");
    expect(refused.status).not.toBe(200);
    expect(JSON.stringify(await refused.json())).toContain("device_limit");
  });

  it("raising it answers no overLimit", async () => {
    await activate("device-two");
    const body = (await (await patch({ deviceLimit: 4 })).json()) as {
      overLimit?: unknown;
    };
    expect(body.overLimit).toBeUndefined();
  });

  it("audits each change old → new, and only real changes", async () => {
    await patch({ deviceLimit: 4 });
    await patch({ deviceLimit: 4 });
    await patch({ deviceLimit: null });
    await patch({ name: "Renamed" });
    const entries = (await listAudit(db, "djdl"))
      .filter((a) => a.action === "license.device_limit.set")
      .sort((a, b) => ((a.summary ?? "") < (b.summary ?? "") ? -1 : 1));
    expect(entries.map((e) => e.summary)).toEqual([
      `Set device limit for ${licenseId}: 4 → inherit`,
      `Set device limit for ${licenseId}: inherit → 4`,
    ]);
    expect(entries[0]).toMatchObject({
      target_kind: "license",
      target_id: licenseId,
      actor_sub: "u1",
    });
  });

  it("refuses deviceLimit on create; a new licence inherits", async () => {
    const res = await admin("POST", "", { name: "New", deviceLimit: 2 });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ fields: ["deviceLimit"] });
    const created = await admin("POST", "", { name: "New" });
    expect(created.status).toBe(201);
    expect(
      ((await created.json()) as { license: Record<string, unknown> }).license,
    ).toMatchObject({ deviceLimit: null, deviceLimitSource: "product" });
  });

  it("the detail read counts seats with the dormancy cutoff", async () => {
    await activate("device-two");
    await db.run(
      "UPDATE devices SET last_seen = ? WHERE product = ? AND device_id = ?",
      NOW - SEAT_DORMANCY_SECONDS - 10,
      "djdl",
      DEVICE,
    );
    expect(await read()).toMatchObject({ deviceCount: 2, seatDeviceCount: 1 });
  });

  it("refuses anything but a positive integer or null", async () => {
    for (const deviceLimit of [0, -1, 1.5, "3", true]) {
      const res = await patch({ deviceLimit });
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({
        fields: ["deviceLimit"],
      });
    }
    expect((await getLicense(db, "djdl", licenseId))!.device_limit).toBeNull();
  });
});
