/**
 * Product-wide devices (`/manage/api/products/<slug>/devices…`): every device of a product,
 * including the ones that hold no license.
 */
import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedLicenseWithKey, seedProduct } from "./seed.js";
import type { Env } from "../src/platform/env.js";
import type { Db } from "../src/db/types.js";
import { handleAdmin } from "../src/console/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
  type SessionIdentity,
} from "../src/core/console/session.js";
import {
  getDevice,
  getFingerprint,
  listAudit,
  upsertDevice,
  upsertFingerprint,
  type DeviceRow,
} from "../src/core/repo.js";
import { getTokenRecord, putTokenRecord } from "../src/platform/kv.js";

const PLATFORM_GROUP = "platform-admins";
const SLUG = "djdl";

const id = (n: number): string => `dev_${String(n).padStart(28, "0")}`;

function mkReq(
  method: string,
  path: string,
  opts: { cookie?: string; csrf?: string } = {},
): Request {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.csrf) headers[CSRF_HEADER] = opts.csrf;
  return new Request(`https://key.plrs.im/manage${path}`, {
    method,
    headers,
  }) as unknown as Request;
}

interface World {
  db: Db;
  env: Env;
  cookie: string;
  csrf: string;
  weak: string;
  call: (method: string, path: string) => Promise<Response>;
}

async function login(env: Env, identity: SessionIdentity) {
  const { token, session } = await issueSession(env, identity, NOW);
  return { cookie: `${ADMIN_COOKIE}=${token}`, csrf: session.csrf };
}

async function world(): Promise<World> {
  const db = makeTestDb();
  const env = makeEnv(new KvMock(), [SLUG]);
  env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
  env.PLATFORM_ADMIN_GROUP = PLATFORM_GROUP;
  await seedProduct(db, SLUG);
  const admin = await login(env, {
    sub: "u1",
    name: "Ada",
    email: "ada@x.io",
    groups: [PLATFORM_GROUP],
  });
  const weak = await login(env, {
    sub: "u9",
    name: "Bob",
    email: "b@x.io",
    groups: [],
  });
  const call = (method: string, path: string): Promise<Response> => {
    const full = `/api/products/${SLUG}${path}`;
    // The dispatcher is handed the path without its query string; the Request keeps it.
    return handleAdmin(
      mkReq(method, full, { cookie: admin.cookie, csrf: admin.csrf }),
      env,
      db,
      full.split("?")[0]!,
      { now: NOW },
    );
  };
  return { db, env, ...admin, weak: weak.cookie, call };
}

function row(n: number, over: Partial<DeviceRow> = {}): DeviceRow {
  return {
    product: SLUG,
    device_id: id(n),
    customer_id: null,
    license_id: "",
    status: "authorized",
    first_seen: NOW - 1000,
    last_seen: NOW - n * 10,
    ua: null,
    label: null,
    overrides_json: null,
    reported_json: null,
    token_hash: null,
    platform: "windows",
    arch: "x86_64",
    app_version: "1.0.0",
    sdk_name: "godot",
    sdk_version: "0.1.0",
    ...over,
  };
}

/** Two licensed devices (on two licenses) and three license-free ones. */
async function fixture(w: World): Promise<{ licA: string; licB: string }> {
  const { licenseId: licA } = await seedLicenseWithKey(w.db, SLUG, {
    id: "lic_a",
  });
  const { licenseId: licB } = await seedLicenseWithKey(w.db, SLUG, {
    id: "lic_b",
  });
  await upsertDevice(w.db, row(1, { license_id: licA, platform: "macos" }));
  await upsertDevice(w.db, row(2, { license_id: licB, app_version: "1.1.0" }));
  await upsertDevice(w.db, row(3, { label: "Steam Deck", platform: "linux" }));
  await upsertDevice(w.db, row(4));
  await upsertDevice(w.db, row(5, { app_version: null, sdk_name: null }));
  return { licA, licB };
}

interface ListBody {
  devices: Array<Record<string, unknown> & { deviceId: string }>;
  nextCursor: string | null;
}

describe("GET /devices (product-wide list)", () => {
  it("lists licensed and license-free devices; licensed=false lists only the license-free", async () => {
    const w = await world();
    await fixture(w);

    const all = (await (await w.call("GET", "/devices")).json()) as ListBody;
    expect(all.devices).toHaveLength(5);
    expect(all.nextCursor).toBeNull();
    // Newest last_seen first.
    expect(all.devices.map((d) => d.deviceId)).toEqual([1, 2, 3, 4, 5].map(id));
    expect(all.devices.filter((d) => d.licenseId !== null)).toHaveLength(2);

    const free = (await (
      await w.call("GET", "/devices?licensed=false")
    ).json()) as ListBody;
    expect(free.devices.map((d) => d.deviceId)).toEqual([3, 4, 5].map(id));
    expect(free.devices.every((d) => d.licenseId === null)).toBe(true);
    expect(free.devices.every((d) => d.seatNo === null)).toBe(true);

    const licensed = (await (
      await w.call("GET", "/devices?licensed=true")
    ).json()) as ListBody;
    expect(licensed.devices.map((d) => d.licenseId)).toEqual([
      "lic_a",
      "lic_b",
    ]);
  });

  it("never loads fingerprint or facts into a list row", async () => {
    const w = await world();
    await fixture(w);
    const body = (await (await w.call("GET", "/devices")).json()) as ListBody;
    for (const d of body.devices) {
      expect(d).not.toHaveProperty("fingerprint");
      expect(d).not.toHaveProperty("facts");
    }
  });

  it("pages with limit=2 and returns every device exactly once", async () => {
    const w = await world();
    await fixture(w);
    // A tie on last_seen must not drop or repeat a row across a page boundary.
    await upsertDevice(w.db, row(6, { last_seen: NOW - 40 }));

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const qs = new URLSearchParams({ limit: "2" });
      if (cursor) qs.set("cursor", cursor);
      const page = (await (
        await w.call("GET", `/devices?${qs}`)
      ).json()) as ListBody;
      expect(page.devices.length).toBeLessThanOrEqual(2);
      seen.push(...page.devices.map((d) => d.deviceId));
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5, 6].map(id));
    expect(new Set(seen).size).toBe(6);
  });

  it("filters by status, platform and a literal id/label prefix", async () => {
    const w = await world();
    await fixture(w);
    await upsertDevice(w.db, row(7, { status: "deauthorized" }));

    const def = (await (await w.call("GET", "/devices")).json()) as ListBody;
    expect(def.devices.map((d) => d.deviceId)).not.toContain(id(7));
    const deauth = (await (
      await w.call("GET", "/devices?status=deauthorized")
    ).json()) as ListBody;
    expect(deauth.devices.map((d) => d.deviceId)).toEqual([id(7)]);
    const every = (await (
      await w.call("GET", "/devices?status=all")
    ).json()) as ListBody;
    expect(every.devices).toHaveLength(6);

    const linux = (await (
      await w.call("GET", "/devices?platform=linux")
    ).json()) as ListBody;
    expect(linux.devices.map((d) => d.deviceId)).toEqual([id(3)]);

    const byLabel = (await (
      await w.call("GET", "/devices?q=steam")
    ).json()) as ListBody;
    expect(byLabel.devices.map((d) => d.deviceId)).toEqual([id(3)]);
    const byId = (await (
      await w.call("GET", `/devices?q=${id(4)}`)
    ).json()) as ListBody;
    expect(byId.devices.map((d) => d.deviceId)).toEqual([id(4)]);
    // `%` is literal, not a wildcard.
    const wild = (await (
      await w.call("GET", "/devices?q=%25")
    ).json()) as ListBody;
    expect(wild.devices).toEqual([]);
  });

  it("rejects malformed query parameters with 400", async () => {
    const w = await world();
    for (const qs of [
      "status=bogus",
      "licensed=maybe",
      "limit=0",
      "limit=201",
      "limit=abc",
      "cursor=not-a-cursor",
    ]) {
      const res = await w.call("GET", `/devices?${qs}`);
      expect(res.status, qs).toBe(400);
    }
  });

  it("does not list another product's devices", async () => {
    const w = await world();
    await fixture(w);
    await seedProduct(w.db, "other");
    await upsertDevice(w.db, row(9, { product: "other" }));
    const body = (await (await w.call("GET", "/devices")).json()) as ListBody;
    expect(body.devices.map((d) => d.deviceId)).not.toContain(id(9));
  });
});

describe("GET /devices/summary", () => {
  it("counts match the fixture", async () => {
    const w = await world();
    await fixture(w);
    await upsertDevice(w.db, row(7, { status: "deauthorized" }));
    const s = (await (await w.call("GET", "/devices/summary")).json()) as {
      total: number;
      byStatus: Array<{ value: string; count: number }>;
      licensed: { licensed: number; licenseFree: number };
      byPlatform: Array<{ value: string | null; count: number }>;
      byArch: Array<{ value: string | null; count: number }>;
      bySdkName: Array<{ value: string | null; count: number }>;
      byAppVersion: Array<{ value: string | null; count: number }>;
    };
    expect(s.total).toBe(6);
    expect(s.byStatus).toEqual([
      { value: "authorized", count: 5 },
      { value: "deauthorized", count: 1 },
    ]);
    expect(s.licensed).toEqual({ licensed: 2, licenseFree: 3 });
    expect(s.byPlatform).toEqual([
      { value: "windows", count: 3 },
      { value: "linux", count: 1 },
      { value: "macos", count: 1 },
    ]);
    expect(s.byArch).toEqual([{ value: "x86_64", count: 5 }]);
    expect(s.bySdkName).toEqual([
      { value: "godot", count: 4 },
      { value: null, count: 1 },
    ]);
    expect(s.byAppVersion).toEqual([
      { value: "1.0.0", count: 3 },
      { value: "1.1.0", count: 1 },
      { value: null, count: 1 },
    ]);
  });

  it("returns at most the top 20 app versions", async () => {
    const w = await world();
    for (let n = 1; n <= 25; n++)
      await upsertDevice(w.db, row(n, { app_version: `1.0.${n}` }));
    const s = (await (await w.call("GET", "/devices/summary")).json()) as {
      byAppVersion: unknown[];
    };
    expect(s.byAppVersion).toHaveLength(20);
  });

  it("an empty product has zero counts, not an error", async () => {
    const w = await world();
    const s = (await (await w.call("GET", "/devices/summary")).json()) as {
      total: number;
      licensed: { licensed: number; licenseFree: number };
    };
    expect(s.total).toBe(0);
    expect(s.licensed).toEqual({ licensed: 0, licenseFree: 0 });
  });
});

describe("GET /devices/<id>", () => {
  it("returns the device with its fingerprint, and 404s an unknown id", async () => {
    const w = await world();
    await fixture(w);
    await upsertFingerprint(w.db, {
      product: SLUG,
      device_id: id(3),
      hwid: "h".repeat(64),
      components_json: JSON.stringify({ cpu: "c".repeat(64) }),
      anchor_hash: null,
      status: "verified",
      first_seen: NOW,
      last_seen: NOW,
      last_drift_at: null,
      last_drift_count: null,
    });
    const res = await w.call("GET", `/devices/${id(3)}`);
    expect(res.status).toBe(200);
    const d = (await res.json()) as Record<string, unknown>;
    expect(d.deviceId).toBe(id(3));
    expect(d.licenseId).toBeNull();
    expect(d.fingerprint).toMatchObject({
      status: "verified",
      hwid: "hhhhhhhhhhhh",
    });
    expect(d).toHaveProperty("facts");
    expect((await w.call("GET", `/devices/${id(99)}`)).status).toBe(404);
  });
});

describe("device actions", () => {
  it("deauthorizes a license-free device: status, token record and audit row", async () => {
    const w = await world();
    await fixture(w);
    await upsertDevice(w.db, row(8, { token_hash: "tokhash8" }));
    await putTokenRecord(w.env, SLUG, "tokhash8", {
      product: SLUG,
      deviceId: id(8),
      licenseId: "",
    });
    await upsertFingerprint(w.db, {
      product: SLUG,
      device_id: id(8),
      hwid: "h",
      components_json: "{}",
      anchor_hash: null,
      status: "verified",
      first_seen: NOW,
      last_seen: NOW,
      last_drift_at: null,
      last_drift_count: null,
    });

    const res = await w.call("POST", `/devices/${id(8)}/deauthorize`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deviceId: id(8) });

    expect((await getDevice(w.db, SLUG, id(8)))?.status).toBe("deauthorized");
    expect(await getTokenRecord(w.env, SLUG, "tokhash8")).toBeNull();
    expect(await getFingerprint(w.db, SLUG, id(8))).toBeNull();
    const audits = await listAudit(w.db, SLUG, { limit: 10 });
    const a = audits.find((r) => r.action === "device.deauthorize");
    expect(a).toMatchObject({
      target_kind: "device",
      target_id: id(8),
      actor_sub: "u1",
    });
  });

  it("resets a fingerprint without deauthorizing, and audits it", async () => {
    const w = await world();
    await fixture(w);
    await upsertFingerprint(w.db, {
      product: SLUG,
      device_id: id(3),
      hwid: "h",
      components_json: "{}",
      anchor_hash: null,
      status: "verified",
      first_seen: NOW,
      last_seen: NOW,
      last_drift_at: null,
      last_drift_count: null,
    });
    const res = await w.call("POST", `/devices/${id(3)}/fingerprint/reset`);
    expect(res.status).toBe(200);
    expect(await getFingerprint(w.db, SLUG, id(3))).toBeNull();
    expect((await getDevice(w.db, SLUG, id(3)))?.status).toBe("authorized");
    const audits = await listAudit(w.db, SLUG, { limit: 10 });
    expect(audits.some((r) => r.action === "device.fingerprint.reset")).toBe(
      true,
    );
  });

  it("404s an unknown device and an unknown action; 405s a wrong method", async () => {
    const w = await world();
    await fixture(w);
    expect(
      (await w.call("POST", `/devices/${id(99)}/deauthorize`)).status,
    ).toBe(404);
    expect((await w.call("POST", `/devices/${id(3)}/explode`)).status).toBe(
      404,
    );
    expect((await w.call("GET", `/devices/${id(3)}/deauthorize`)).status).toBe(
      405,
    );
    expect((await w.call("DELETE", `/devices/${id(3)}`)).status).toBe(405);
    expect((await w.call("POST", "/devices")).status).toBe(405);
  });

  it("the license route still refuses a device that belongs to another license, and shares its effect", async () => {
    const w = await world();
    const { licA, licB } = await fixture(w);

    // id(2) belongs to lic_b: unchanged 404 through lic_a.
    const wrong = await w.call(
      "POST",
      `/license/licenses/${licA}/devices/${id(2)}`,
    );
    expect(wrong.status).toBe(404);
    expect((await getDevice(w.db, SLUG, id(2)))?.status).toBe("authorized");
    // A license-free device is not reachable through any license either.
    expect(
      (await w.call("POST", `/license/licenses/${licA}/devices/${id(3)}`))
        .status,
    ).toBe(404);

    // Through the right license it deauthorizes, with the same audit row.
    const ok = await w.call(
      "DELETE",
      `/license/licenses/${licB}/devices/${id(2)}`,
    );
    expect(ok.status).toBe(200);
    expect((await getDevice(w.db, SLUG, id(2)))?.status).toBe("deauthorized");
    const audits = await listAudit(w.db, SLUG, { limit: 10 });
    expect(
      audits.filter((r) => r.action === "device.deauthorize"),
    ).toHaveLength(1);
  });

  it("requires a CSRF token on a mutation", async () => {
    const w = await world();
    await fixture(w);
    const p = `/api/products/${SLUG}/devices/${id(3)}/deauthorize`;
    const res = await handleAdmin(
      mkReq("POST", p, { cookie: w.cookie }),
      w.env,
      w.db,
      p,
      { now: NOW },
    );
    expect(res.status).toBe(403);
    expect((await getDevice(w.db, SLUG, id(3)))?.status).toBe("authorized");
  });
});

describe("access control", () => {
  it("401s without a session and 403s a non-admin, for every route", async () => {
    const w = await world();
    await fixture(w);
    const routes: Array<[string, string]> = [
      ["GET", "/devices"],
      ["GET", "/devices/summary"],
      ["GET", `/devices/${id(3)}`],
      ["POST", `/devices/${id(3)}/deauthorize`],
      ["POST", `/devices/${id(3)}/fingerprint/reset`],
    ];
    for (const [method, path] of routes) {
      const full = `/api/products/${SLUG}${path}`;
      const anon = await handleAdmin(mkReq(method, full), w.env, w.db, full, {
        now: NOW,
      });
      expect(anon.status, `${method} ${path} anon`).toBe(401);
      const weak = await handleAdmin(
        mkReq(method, full, { cookie: w.weak }),
        w.env,
        w.db,
        full,
        { now: NOW },
      );
      expect(weak.status, `${method} ${path} non-admin`).toBe(403);
    }
    expect((await getDevice(w.db, SLUG, id(3)))?.status).toBe("authorized");
  });
});
