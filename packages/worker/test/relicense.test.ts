// Remote re-licensing: changing a license's tier and having running clients pick it up.
//
// The mechanism is deliberately boring — resolveEffective() already re-merges on every
// /config request, so the tier change lands with no push channel. What these tests pin is
// that the change is actually VISIBLE to a client (the injected entitlements and a changed
// ETag) and that a downgrade grandfathers existing devices instead of evicting them.

import { beforeEach, describe, expect, it } from "vitest";
import { verifyJws } from "@polaris-key/jws";
import type { ManagedConfigDoc } from "@polaris-key/protocol";
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
import type { Env } from "../src/env.js";
import { loadProduct, type Product } from "../src/product.js";
import { handleActivate, handleConfig } from "../src/licensing.js";
import { handleAdmin } from "../src/admin/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/admin/session.js";
import { listAudit } from "../src/repo.js";

const TRUST = { [TEST_KID]: TEST_PUB };
const PLATFORM_GROUP = "admins";
const DEVICE = "device-fixture-01";

describe("remote re-licensing", () => {
  let db: SqliteDb;
  let env: Env;
  let product: Product;
  let licenseId: string;
  let token: string;

  beforeEach(async () => {
    db = makeTestDb();
    env = makeEnv(new KvMock(), ["djdl"]);
    env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
    env.PLATFORM_ADMIN_GROUP = PLATFORM_GROUP;
    await seedProduct(db, "djdl");
    await seedTier(db, "djdl", "free", { deviceLimit: 5 });
    await seedTier(db, "djdl", "pro", { deviceLimit: 10 });
    await seedTier(db, "djdl", "solo", { deviceLimit: 1 });

    const seeded = await seedLicenseWithKey(db, "djdl", { tierId: "free" });
    licenseId = seeded.licenseId;
    product = (await loadProduct(env, db, "djdl"))!;
    const res = await handleActivate(
      mkReq("POST", {
        authorization: `Bearer ${seeded.key}`,
        "x-pkey-device": DEVICE,
      }),
      env,
      db,
      product,
      NOW,
    );
    token = ((await res.json()) as { token: string }).token;
  });

  async function config(): Promise<Response> {
    return handleConfig(
      mkReq("GET", {
        authorization: `Bearer ${token}`,
        "x-pkey-device": DEVICE,
      }),
      env,
      db,
      product,
      NOW,
    );
  }

  async function docFrom(res: Response): Promise<ManagedConfigDoc> {
    const verified = await verifyJws(await res.text(), TRUST);
    return verified!.payload as ManagedConfigDoc;
  }

  async function adminPatch(body: unknown): Promise<Response> {
    const { token: cookieToken, session } = await issueSession(
      env,
      { sub: "u1", name: "Ada", email: "a@x.io", groups: [PLATFORM_GROUP] },
      NOW,
    );
    return handleAdmin(
      mkReq(
        "PATCH",
        {
          cookie: `${ADMIN_COOKIE}=${cookieToken}`,
          [CSRF_HEADER]: session.csrf,
          "content-type": "application/json",
        },
        body,
      ),
      env,
      db,
      `/api/products/djdl/licenses/${licenseId}`,
      { now: NOW },
    );
  }

  it("exposes the tier to the client as entitlements", async () => {
    const doc = await docFrom(await config());
    expect(doc.payload.entitlements["license.tier"]).toMatchObject({
      state: "enforced",
      value: "free",
    });
    expect(doc.payload.entitlements["license.tierLabel"]).toMatchObject({
      value: "free",
    });
  });

  it("changes the client's entitlements on the next config fetch", async () => {
    const before = await docFrom(await config());
    expect(before.payload.entitlements["deviceLimit"]?.value).toBe(5);

    expect((await adminPatch({ tier: "pro" })).status).toBe(200);

    const after = await docFrom(await config());
    expect(after.payload.entitlements["license.tier"]?.value).toBe("pro");
    expect(after.payload.entitlements["deviceLimit"]?.value).toBe(10);
  });

  it("changes the ETag, which is how the SDK detects a real change", async () => {
    // computeETag excludes issuedAt/expiresAt/graceUntil, so a differing tag means the
    // CONTENT differs — that is exactly the signal the SDKs' onChange fires on.
    const beforeEtag = (await config()).headers.get("etag");
    await adminPatch({ tier: "pro" });
    const afterEtag = (await config()).headers.get("etag");
    expect(afterEtag).not.toBe(beforeEtag);
  });

  it("keeps the ETag stable when nothing changed", async () => {
    const a = (await config()).headers.get("etag");
    const b = (await config()).headers.get("etag");
    expect(b).toBe(a);
  });

  it("audits the tier change with old → new", async () => {
    await adminPatch({ tier: "pro" });
    const entry = (await listAudit(db, "djdl")).find(
      (a) => a.action === "license.tier.change",
    );
    expect(entry?.summary).toContain("free");
    expect(entry?.summary).toContain("pro");
  });

  it("does not log a tier change when the tier did not change", async () => {
    await adminPatch({ name: "Renamed" });
    const entries = (await listAudit(db, "djdl")).filter(
      (a) => a.action === "license.tier.change",
    );
    expect(entries).toHaveLength(0);
  });

  it("reports an over-limit downgrade instead of evicting devices", async () => {
    // Two devices active, then a downgrade to a 1-device tier.
    const secondKey = await seedKeyForLicense(db, "djdl", licenseId);
    const second = await handleActivate(
      mkReq("POST", {
        authorization: `Bearer ${secondKey}`,
        "x-pkey-device": "device-two",
      }),
      env,
      db,
      product,
      NOW,
    );
    expect(second.status).toBe(200);

    const res = await adminPatch({ tier: "solo" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      overLimit: { deviceCount: 2, deviceLimit: 1 },
    });

    // Grandfathered: both devices still authorized and still served config.
    expect((await config()).status).toBe(200);
    const rows = await db.all<{ n: number }>(
      "SELECT COUNT(*) AS n FROM devices WHERE product = ? AND license_id = ? AND status = 'authorized'",
      "djdl",
      licenseId,
    );
    expect(rows[0]?.n).toBe(2);
  });

  it("refuses a NEW activation once over the downgraded limit", async () => {
    const key = await seedKeyForLicense(db, "djdl", licenseId);
    await adminPatch({ tier: "solo" });
    const res = await handleActivate(
      mkReq("POST", {
        authorization: `Bearer ${key}`,
        "x-pkey-device": "device-new",
      }),
      env,
      db,
      product,
      NOW,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "device_limit" });
  });

  it("omits the tier entitlements when a license has no tier", async () => {
    await adminPatch({ tier: null });
    const doc = await docFrom(await config());
    expect(doc.payload.entitlements["license.tier"]).toBeUndefined();
  });
});
