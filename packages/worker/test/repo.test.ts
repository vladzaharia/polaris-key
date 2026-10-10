import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { NOW, seedProduct } from "./seed.js";
import type { SqliteDb } from "../src/db/sqlite.js";
import {
  appendAudit,
  countActiveDevices,
  getKey,
  getLicense,
  getLicenseBySub,
  getDevice,
  getProfile,
  getTier,
  insertKey,
  insertLicense,
  listAudit,
  listKeysByLicense,
  listDevicesByLicense,
  listProducts,
  setKeyStatus,
  setDeviceReported,
  setDeviceStatus,
  touchKey,
  upsertDevice,
  type AuditRow,
  type LicenseRow,
  type DeviceRow,
} from "../src/core/repo.js";

const lic = (
  slug: string,
  id: string,
  over: Partial<LicenseRow> = {},
): LicenseRow => ({
  product: slug,
  id,
  status: "active",
  sub: null,
  name: null,
  email: null,
  groups_json: null,
  tier_id: null,
  activated_at: NOW,
  expires_at: null,
  max_offline_days: null,
  overrides_json: null,
  channels_json: null,
  min_version: null,
  max_version: null,
  modified_by: null,
  modified_at: NOW,
  ...over,
});

const device = (
  slug: string,
  id: string,
  licId: string,
  over: Partial<DeviceRow> = {},
): DeviceRow => ({
  product: slug,
  device_id: id,
  customer_id: null,
  license_id: licId,
  status: "authorized",
  first_seen: NOW,
  last_seen: NOW,
  ua: null,
  label: null,
  overrides_json: null,
  reported_json: null,
  token_hash: null,
  ...over,
});

const audit = (slug: string, id: string, at: number): AuditRow => ({
  product: slug,
  id,
  at,
  actor_sub: "u1",
  actor_name: "Ada",
  actor_email: "a@x.io",
  action: "license.create",
  target_kind: "license",
  target_id: "lic_1",
  parent_id: null,
  summary: null,
});

describe("repo CRUD round-trips", () => {
  let db: SqliteDb;
  beforeEach(async () => {
    db = makeTestDb();
    await seedProduct(db, "djdl");
  });

  it("products: seed + list", async () => {
    await seedProduct(db, "acme");
    const all = await listProducts(db);
    expect(all.map((p) => p.slug).sort()).toEqual(["acme", "djdl"]);
  });

  it("licenses: insert + get + getBySub", async () => {
    await insertLicense(
      db,
      lic("djdl", "lic_1", { sub: "sub-1", name: "Ada" }),
    );
    expect((await getLicense(db, "djdl", "lic_1"))?.name).toBe("Ada");
    expect((await getLicenseBySub(db, "djdl", "sub-1"))?.id).toBe("lic_1");
    expect(await getLicense(db, "djdl", "nope")).toBeNull();
  });

  it("keys: insert + get + listByLicense + touch + setStatus", async () => {
    await insertLicense(db, lic("djdl", "lic_1"));
    await insertKey(db, {
      product: "djdl",
      key_hash: "h1",
      license_id: "lic_1",
      status: "active",
      label: null,
      created_at: NOW,
      created_by: null,
      last_used_at: null,
    });
    expect((await getKey(db, "djdl", "h1"))?.status).toBe("active");
    expect((await listKeysByLicense(db, "djdl", "lic_1")).length).toBe(1);

    await touchKey(db, "djdl", "h1", NOW + 5);
    expect((await getKey(db, "djdl", "h1"))?.last_used_at).toBe(NOW + 5);

    await setKeyStatus(db, "djdl", "h1", "revoked");
    expect((await getKey(db, "djdl", "h1"))?.status).toBe("revoked");
  });

  it("devices: upsert (insert then update), get, listByLicense", async () => {
    await insertLicense(db, lic("djdl", "lic_1"));
    await upsertDevice(db, device("djdl", "dev-1", "lic_1", { ua: "first" }));
    expect((await getDevice(db, "djdl", "dev-1"))?.ua).toBe("first");

    // Upsert again updates last_seen/ua/status while keeping first_seen via caller.
    await upsertDevice(
      db,
      device("djdl", "dev-1", "lic_1", { ua: "second", last_seen: NOW + 9 }),
    );
    const m = await getDevice(db, "djdl", "dev-1");
    expect(m?.ua).toBe("second");
    expect(m?.last_seen).toBe(NOW + 9);
    expect((await listDevicesByLicense(db, "djdl", "lic_1")).length).toBe(1);
  });

  it("devices: setStatus + setReported", async () => {
    await insertLicense(db, lic("djdl", "lic_1"));
    await upsertDevice(db, device("djdl", "dev-1", "lic_1"));
    await setDeviceStatus(db, "djdl", "dev-1", "deauthorized");
    expect((await getDevice(db, "djdl", "dev-1"))?.status).toBe("deauthorized");
    await setDeviceReported(
      db,
      "djdl",
      "dev-1",
      JSON.stringify({ v: "1.2.3" }),
      NOW + 1,
    );
    const m = await getDevice(db, "djdl", "dev-1");
    expect(m?.reported_json).toBe(JSON.stringify({ v: "1.2.3" }));
    expect(m?.last_seen).toBe(NOW + 1);
  });

  it("profiles + tiers: get", async () => {
    await db.run(
      "INSERT INTO profiles (product, id, name, description, payload_json, modified_by, modified_at) VALUES (?,?,?,?,?,?,?)",
      "djdl",
      "prof_1",
      "Base",
      null,
      JSON.stringify({ config: {}, secrets: {}, entitlements: {} }),
      null,
      NOW,
    );
    await db.run(
      "INSERT INTO tiers (product, id, label, profile_id, policy_expiry_days, policy_device_limit, modified_by, modified_at) VALUES (?,?,?,?,?,?,?,?)",
      "djdl",
      "pro",
      "Pro",
      "prof_1",
      365,
      3,
      null,
      NOW,
    );
    expect((await getProfile(db, "djdl", "prof_1"))?.name).toBe("Base");
    expect((await getTier(db, "djdl", "pro"))?.policy_device_limit).toBe(3);
  });
});

describe("countActiveDevices", () => {
  let db: SqliteDb;
  beforeEach(async () => {
    db = makeTestDb();
    await seedProduct(db, "djdl");
    await insertLicense(db, lic("djdl", "lic_1"));
  });

  it("counts only authorized devices for the license", async () => {
    await upsertDevice(
      db,
      device("djdl", "dev-1", "lic_1", { status: "authorized" }),
    );
    await upsertDevice(
      db,
      device("djdl", "dev-2", "lic_1", { status: "authorized" }),
    );
    await upsertDevice(
      db,
      device("djdl", "dev-3", "lic_1", { status: "deauthorized" }),
    );
    expect(await countActiveDevices(db, "djdl", "lic_1")).toBe(2);
  });

  it("is zero when there are none", async () => {
    expect(await countActiveDevices(db, "djdl", "lic_1")).toBe(0);
  });
});

describe("audit keyset pagination (at DESC, id DESC)", () => {
  let db: SqliteDb;
  beforeEach(async () => {
    db = makeTestDb();
    await seedProduct(db, "djdl");
  });

  it("orders newest-first by (at, id)", async () => {
    await appendAudit(db, audit("djdl", "a", 100));
    await appendAudit(db, audit("djdl", "b", 200));
    await appendAudit(db, audit("djdl", "c", 200)); // tie on at → id DESC
    const rows = await listAudit(db, "djdl", {});
    expect(rows.map((r) => r.id)).toEqual(["c", "b", "a"]);
  });

  it("paginates with a cursor that excludes the boundary row", async () => {
    for (const [id, at] of [
      ["a", 100],
      ["b", 200],
      ["c", 300],
      ["d", 400],
    ] as const) {
      await appendAudit(db, audit("djdl", id, at));
    }
    const page1 = await listAudit(db, "djdl", { limit: 2 });
    expect(page1.map((r) => r.id)).toEqual(["d", "c"]);
    const last = page1[page1.length - 1]!;
    const page2 = await listAudit(db, "djdl", {
      beforeAt: last.at,
      beforeId: last.id,
      limit: 2,
    });
    expect(page2.map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("cursor respects the (at = ? AND id < ?) tiebreak", async () => {
    await appendAudit(db, audit("djdl", "x", 500));
    await appendAudit(db, audit("djdl", "y", 500));
    // Cursor at the higher id "y" should return only "x" (same at, lower id).
    const rows = await listAudit(db, "djdl", { beforeAt: 500, beforeId: "y" });
    expect(rows.map((r) => r.id)).toEqual(["x"]);
  });
});

describe("product scope isolation", () => {
  let db: SqliteDb;
  beforeEach(async () => {
    db = makeTestDb();
    await seedProduct(db, "djdl");
    await seedProduct(db, "acme");
  });

  it("a license query for product A never returns product B's rows", async () => {
    await insertLicense(db, lic("djdl", "lic_shared", { sub: "same-sub" }));
    await insertLicense(db, lic("acme", "lic_shared", { sub: "same-sub" }));
    expect((await getLicense(db, "djdl", "lic_shared"))?.product).toBe("djdl");
    expect((await getLicense(db, "acme", "lic_shared"))?.product).toBe("acme");
    // Same OIDC sub in both products resolves to the correct tenant's license.
    expect((await getLicenseBySub(db, "djdl", "same-sub"))?.product).toBe(
      "djdl",
    );
    expect((await getLicenseBySub(db, "acme", "same-sub"))?.product).toBe(
      "acme",
    );
  });

  it("a key query for product A never returns product B's keys", async () => {
    await insertLicense(db, lic("djdl", "lic_1"));
    await insertLicense(db, lic("acme", "lic_1"));
    await insertKey(db, {
      product: "djdl",
      key_hash: "samehash",
      license_id: "lic_1",
      status: "active",
      label: null,
      created_at: NOW,
      created_by: null,
      last_used_at: null,
    });
    await insertKey(db, {
      product: "acme",
      key_hash: "samehash",
      license_id: "lic_1",
      status: "revoked",
      label: null,
      created_at: NOW,
      created_by: null,
      last_used_at: null,
    });
    expect((await getKey(db, "djdl", "samehash"))?.status).toBe("active");
    expect((await getKey(db, "acme", "samehash"))?.status).toBe("revoked");
  });

  it("audit lists are product-scoped", async () => {
    await appendAudit(db, audit("djdl", "d1", 100));
    await appendAudit(db, audit("acme", "a1", 100));
    expect((await listAudit(db, "djdl", {})).map((r) => r.id)).toEqual(["d1"]);
    expect((await listAudit(db, "acme", {})).map((r) => r.id)).toEqual(["a1"]);
  });

  it("countActiveDevices is product-scoped", async () => {
    await insertLicense(db, lic("djdl", "lic_1"));
    await insertLicense(db, lic("acme", "lic_1"));
    await upsertDevice(db, device("djdl", "dev-1", "lic_1"));
    await upsertDevice(db, device("acme", "dev-1", "lic_1"));
    await upsertDevice(db, device("acme", "dev-2", "lic_1"));
    expect(await countActiveDevices(db, "djdl", "lic_1")).toBe(1);
    expect(await countActiveDevices(db, "acme", "lic_1")).toBe(2);
  });
});
