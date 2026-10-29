/**
 * The Core admin additions the redesigned console reads (docs/design/ADMIN.md §7.3, chunk 5):
 *
 *   A-2  `GET …/activity` filters (action prefix, actor, target, date range)
 *   A-3  `PATCH …` refuses a blank name (the admin group is no longer written, ST-32.6)
 *   A-4  `GET …/keys` lists signing keys with their lifecycle state, public material only;
 *        UX-29 adds `refresh`, the active devices back since the last rotation
 *   A-5  `GET …/secrets` lists secrets' metadata and what requires each, never a value
 *
 * Admin routes are narrative-only (`routeCoverage.test.ts` NARRATIVE_ONLY): no OpenAPI entry.
 */
import { describe, expect, it } from "vitest";
import { NOW, seedProductSecret } from "../../seed.js";
import { adminWorld } from "../../adminWorld.js";
import type { Env } from "../../../src/platform/env.js";
import type { Db } from "../../../src/db/types.js";
import { getProduct } from "../../../src/core/products/store.js";
import { appendAudit, listAudit } from "../../../src/core/audit.js";

const PLATFORM_GROUP = "platform-admins";
const SLUG = "djdl";

interface World {
  db: Db;
  env: Env;
  call: (method: string, path: string, body?: unknown) => Promise<Response>;
}

async function world(): Promise<World> {
  const w = await adminWorld({
    products: [SLUG],
    groups: { platform: PLATFORM_GROUP },
  });
  // A proven step-up: break-glass activation below is in the step-up table.
  const as = await w.login({
    sub: "u1",
    name: "Ada",
    email: "ada@x.io",
    groups: [PLATFORM_GROUP],
    authTime: NOW,
    stepUp: true,
  });
  const call = (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> =>
    w.call(method, `/api/products/${SLUG}${path}`, { body, as });
  return { db: w.db, env: w.env, call };
}

async function seedAudit(db: Db): Promise<void> {
  const rows: [string, number, string | null, string, string | null, string][] =
    [
      ["a1", 100, "u1", "license.create", "license", "lic_1"],
      ["a2", 200, "u2", "license.tier.change", "license", "lic_1"],
      ["a3", 300, "u1", "profile.create", "profile", "pro"],
      ["a4", 400, null, "device.fingerprint.drift", "device", "dev_1"],
      ["a5", 500, "u2", "licensee.odd", "license", "lic_2"],
    ];
  for (const [id, at, sub, action, kind, target] of rows) {
    await appendAudit(db, {
      product: SLUG,
      id,
      at,
      actor_sub: sub,
      actor_name: sub ? `name-${sub}` : null,
      actor_email: sub ? `${sub}@x.io` : null,
      action,
      target_kind: kind,
      target_id: target,
      parent_id: null,
      summary: `${action} ${target}`,
    });
  }
}

async function activityIds(w: World, query: string): Promise<string[]> {
  const res = await w.call("GET", `/activity?${query}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: { id: string }[] };
  return body.items.map((i) => i.id);
}

describe("A-2: activity filters", () => {
  it("filters by action prefix, with the dot literal (license. does not match licensee.)", async () => {
    const w = await world();
    await seedAudit(w.db);
    expect(await activityIds(w, "action=license.")).toEqual(["a2", "a1"]);
    expect(await activityIds(w, "action=license")).toEqual(["a5", "a2", "a1"]);
  });

  it("filters by actor subject or email, and `system` matches runtime rows", async () => {
    const w = await world();
    await seedAudit(w.db);
    expect(await activityIds(w, "actor=u1")).toEqual(["a3", "a1"]);
    expect(await activityIds(w, "actor=u2%40x.io")).toEqual(["a5", "a2"]);
    expect(await activityIds(w, "actor=system")).toEqual(["a4"]);
  });

  it("filters by target kind and id (a record's History tab)", async () => {
    const w = await world();
    await seedAudit(w.db);
    expect(await activityIds(w, "targetKind=license&targetId=lic_1")).toEqual([
      "a2",
      "a1",
    ]);
    expect(await activityIds(w, "targetKind=profile")).toEqual(["a3"]);
  });

  it("filters by an inclusive date range", async () => {
    const w = await world();
    await seedAudit(w.db);
    expect(await activityIds(w, "since=200&until=400")).toEqual([
      "a4",
      "a3",
      "a2",
    ]);
  });

  it("pages through matching rows only, with the same filters on every page", async () => {
    const w = await world();
    await seedAudit(w.db);
    const first = await w.call("GET", "/activity?action=license&limit=2");
    const page = (await first.json()) as {
      items: { id: string }[];
      nextCursor: { beforeAt: number; beforeId: string } | null;
    };
    expect(page.items.map((i) => i.id)).toEqual(["a5", "a2"]);
    expect(page.nextCursor).toEqual({ beforeAt: 200, beforeId: "a2" });
    expect(
      await activityIds(
        w,
        `action=license&limit=2&beforeAt=${page.nextCursor!.beforeAt}&beforeId=${page.nextCursor!.beforeId}`,
      ),
    ).toEqual(["a1"]);
  });

  it("ST-24: format=ndjson downloads the filtered history, one object per line", async () => {
    const w = await world();
    await seedAudit(w.db);
    const res = await w.call("GET", "/activity?action=license.&format=ndjson");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("x-pkey-truncated")).toBeNull();
    const lines = (await res.text()).trimEnd().split("\n");
    expect(lines.map((l) => JSON.parse(l).id)).toEqual(["a2", "a1"]);
    const bad = await w.call("GET", "/activity?since=yesterday&format=ndjson");
    expect(bad.status).toBe(422);
  });

  it("refuses a malformed filter with the field named", async () => {
    const w = await world();
    const res = await w.call("GET", "/activity?since=yesterday");
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { fields: string[] } };
    expect(body.error.fields).toEqual(["since"]);
  });

  it("still serves the unfiltered feed exactly as before", async () => {
    const w = await world();
    await seedAudit(w.db);
    expect(await activityIds(w, "limit=50")).toEqual([
      "a5",
      "a4",
      "a3",
      "a2",
      "a1",
    ]);
  });
});

describe("A-3: product PATCH refuses a blank name and no longer writes the admin group", () => {
  it("ignores adminGroup: the column is never written (ST-32.6)", async () => {
    const w = await world();
    const res = await w.call("PATCH", "", {
      adminGroup: "djdl-admins",
      defaultDeviceLimit: 4,
    });
    expect(res.status).toBe(200);
    expect((await getProduct(w.db, SLUG))?.admin_group).toBeNull();
  });

  it("a blank display name is refused, not silently ignored", async () => {
    const w = await world();
    const res = await w.call("PATCH", "", { name: "  " });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { fields: string[] } };
    expect(body.error.fields).toEqual(["name"]);
    expect((await getProduct(w.db, SLUG))?.name).toBe(SLUG);
  });
});

describe("ST-08: product PATCH sets the web origins", () => {
  it("writes the list, reads it back on the product and audits it", async () => {
    const w = await world();
    const res = await w.call("PATCH", "", {
      webOrigins: ["https://app.example.com", "http://localhost:5173"],
    });
    expect(res.status).toBe(200);
    expect(
      JSON.parse((await getProduct(w.db, SLUG))!.web_origins_json!),
    ).toEqual(["https://app.example.com", "http://localhost:5173"]);
    const read = (await (await w.call("GET", "")).json()) as {
      product: { webOrigins: string[] };
    };
    expect(read.product.webOrigins).toEqual([
      "https://app.example.com",
      "http://localhost:5173",
    ]);
    expect(
      (await listAudit(w.db, SLUG, { action: "product.update" })).length,
    ).toBe(1);
  });

  it("an empty list clears them", async () => {
    const w = await world();
    await w.call("PATCH", "", { webOrigins: ["https://a.example"] });
    const res = await w.call("PATCH", "", { webOrigins: [] });
    expect(res.status).toBe(200);
    expect((await getProduct(w.db, SLUG))?.web_origins_json).toBeNull();
  });

  it.each([
    ["a path", ["https://a.example/x"]],
    ["a wildcard", ["https://*.example.com"]],
    ["plain http off localhost", ["http://a.example"]],
    ["a repeat", ["https://a.example", "https://a.example"]],
    ["not a list", "https://a.example"],
  ])("refuses %s with the field named", async (_name, webOrigins) => {
    const w = await world();
    const res = await w.call("PATCH", "", { webOrigins });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { fields: string[] } };
    expect(body.error.fields).toEqual(["webOrigins"]);
  });
});

interface KeyRow {
  kid: string;
  status: string;
  alg: string;
  publicKey: string;
  createdAt: number;
  activateAfter: number | null;
  activatedAt: number | null;
  retiredAt: number | null;
  revokedAt: number | null;
}

describe("A-4: GET …/keys", () => {
  it("lists the active key, then a prepared staged key with its activation time", async () => {
    const w = await world();
    let res = await w.call("GET", "/keys");
    expect(res.status).toBe(200);
    let body = (await res.json()) as { keys: KeyRow[]; now: number };
    expect(body.now).toBe(NOW);
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).toMatchObject({ status: "active", alg: "Ed25519" });
    expect(body.keys[0]!.activatedAt).not.toBeNull();

    const prepared = (await (await w.call("POST", "/keys/prepare")).json()) as {
      kid: string;
      activateAfter: number;
    };
    res = await w.call("GET", "/keys");
    body = (await res.json()) as { keys: KeyRow[]; now: number };
    expect(body.keys.map((k) => k.status)).toEqual(["active", "staged"]);
    const staged = body.keys[1]!;
    expect(staged.kid).toBe(prepared.kid);
    expect(staged.activateAfter).toBe(prepared.activateAfter);
    expect(staged.activatedAt).toBeNull();
  });

  it("shows retired and revoked keys with when they left service", async () => {
    const w = await world();
    const { kid } = (await (await w.call("POST", "/keys/prepare")).json()) as {
      kid: string;
    };
    expect(
      (await w.call("POST", "/keys/activate", { kid, breakGlass: true }))
        .status,
    ).toBe(200);
    const keys = (
      (await (await w.call("GET", "/keys")).json()) as { keys: KeyRow[] }
    ).keys;
    expect(keys.map((k) => k.status)).toEqual(["active", "retired"]);
    expect(keys[1]!.retiredAt).toBe(NOW);
    const old = keys[1]!.kid;
    expect((await w.call("POST", "/keys/revoke", { kid: old })).status).toBe(
      200,
    );
    const after = (
      (await (await w.call("GET", "/keys")).json()) as { keys: KeyRow[] }
    ).keys;
    expect(after[1]).toMatchObject({ kid: old, status: "revoked" });
    expect(after[1]!.revokedAt).toBe(NOW);
  });

  it("never returns private material", async () => {
    const w = await world();
    const text = await (await w.call("GET", "/keys")).text();
    expect(text).not.toContain("enc_private");
    expect(text).not.toContain("PRIVATE KEY");
    expect(text).not.toMatch(/"ct"|"iv"/);
  });

  it("refuses a write without an action", async () => {
    const w = await world();
    expect((await w.call("POST", "/keys")).status).toBe(405);
  });
});

describe("UX-29: GET …/keys reports how many active devices refreshed after a rotation", () => {
  async function seedDevice(
    db: Db,
    id: string,
    lastSeen: number,
    status = "authorized",
  ): Promise<void> {
    await db.run(
      `INSERT INTO devices (product, device_id, license_id, status, first_seen, last_seen)
       VALUES (?, ?, 'lic_1', ?, ?, ?)`,
      SLUG,
      id,
      status,
      lastSeen - 10,
      lastSeen,
    );
  }

  it("is null before any rotation (the product's first key replaced nothing)", async () => {
    const w = await world();
    await seedDevice(w.db, "d1", NOW);
    const body = (await (await w.call("GET", "/keys")).json()) as {
      refresh: unknown;
    };
    expect(body.refresh).toBeNull();
  });

  it("is null when the only retired key is a staged one cancelled before it went live", async () => {
    const w = await world();
    const { kid } = (await (await w.call("POST", "/keys/prepare")).json()) as {
      kid: string;
    };
    // Cancelled later than the active key's activation, as an operator would.
    await w.db.run(
      "UPDATE product_keys SET status = 'retired', rotated_at = ? WHERE product = ? AND kid = ?",
      NOW + 120,
      SLUG,
      kid,
    );
    await seedDevice(w.db, "d1", NOW);
    const body = (await (await w.call("GET", "/keys")).json()) as {
      refresh: unknown;
    };
    expect(body.refresh).toBeNull();
  });

  it("counts authorized devices seen in 30 days, and those seen since activation", async () => {
    const w = await world();
    const { kid } = (await (await w.call("POST", "/keys/prepare")).json()) as {
      kid: string;
    };
    await w.call("POST", "/keys/activate", { kid, breakGlass: true });
    await seedDevice(w.db, "back-1", NOW + 60);
    await seedDevice(w.db, "back-2", NOW);
    await seedDevice(w.db, "not-yet", NOW - 3_600);
    await seedDevice(w.db, "dormant", NOW - 40 * 86_400);
    await seedDevice(w.db, "removed", NOW + 60, "deauthorized");
    const body = (await (await w.call("GET", "/keys")).json()) as {
      refresh: Record<string, unknown>;
    };
    expect(body.refresh).toEqual({
      kid,
      activatedAt: NOW,
      activeDevices: 3,
      refreshedDevices: 2,
      windowDays: 30,
    });
  });

  it("reports zero devices rather than a ratio of nothing", async () => {
    const w = await world();
    const { kid } = (await (await w.call("POST", "/keys/prepare")).json()) as {
      kid: string;
    };
    await w.call("POST", "/keys/activate", { kid, breakGlass: true });
    const body = (await (await w.call("GET", "/keys")).json()) as {
      refresh: { activeDevices: number; refreshedDevices: number };
    };
    expect(body.refresh).toMatchObject({
      activeDevices: 0,
      refreshedDevices: 0,
    });
  });

  it("goes quiet once the rotation is older than the 30-day window", async () => {
    const w = await world();
    const { kid } = (await (await w.call("POST", "/keys/prepare")).json()) as {
      kid: string;
    };
    await w.call("POST", "/keys/activate", { kid, breakGlass: true });
    await w.db.run(
      "UPDATE product_keys SET rotated_at = ? WHERE product = ? AND kid = ?",
      NOW - 31 * 86_400,
      SLUG,
      kid,
    );
    const body = (await (await w.call("GET", "/keys")).json()) as {
      refresh: unknown;
    };
    expect(body.refresh).toBeNull();
  });
});

interface SecretRow {
  name: string;
  configured: boolean;
  usage: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  requiredBy: string[];
}

describe("A-5: GET …/secrets", () => {
  it("lists stored secrets' metadata and required secrets nobody set, never a value", async () => {
    const w = await world();
    await seedProductSecret(w.db, SLUG, "PLAIN", "hunter2-plain");
    await seedProductSecret(
      w.db,
      SLUG,
      "EDGE_MINT_STUDIO",
      "hunter2-edge",
      "edge-mint",
    );
    await w.db.run(
      `INSERT INTO edge_mint_config
         (product,id,alg,signing_key_secret,kid,claims_template_json,ttl_seconds,audience,auth_page_template)
       VALUES (?,?,?,?,?,?,?,NULL,NULL)`,
      SLUG,
      "studio",
      "HS256",
      "EDGE_MINT_STUDIO",
      "k1",
      "{}",
      300,
    );
    await w.db.run(
      `INSERT INTO edge_mint_config
         (product,id,alg,signing_key_secret,kid,claims_template_json,ttl_seconds,audience,auth_page_template)
       VALUES (?,?,?,?,?,?,?,NULL,NULL)`,
      SLUG,
      "lab",
      "HS256",
      "EDGE_MINT_LAB",
      "k2",
      "{}",
      300,
    );
    const res = await w.call("GET", "/secrets");
    expect(res.status).toBe(200);
    const text = await res.clone().text();
    expect(text).not.toContain("hunter2");
    const { secrets } = (await res.json()) as { secrets: SecretRow[] };
    expect(secrets).toEqual([
      {
        name: "EDGE_MINT_LAB",
        configured: false,
        usage: null,
        createdAt: null,
        updatedAt: null,
        requiredBy: ["Edge mint lab"],
      },
      {
        name: "EDGE_MINT_STUDIO",
        configured: true,
        usage: "edge-mint",
        createdAt: NOW,
        updatedAt: NOW,
        requiredBy: ["Edge mint studio"],
      },
      {
        name: "PLAIN",
        configured: true,
        usage: "general",
        createdAt: NOW,
        updatedAt: NOW,
        requiredBy: [],
      },
    ]);
  });

  it("is empty for a product with no secrets", async () => {
    const w = await world();
    const { secrets } = (await (await w.call("GET", "/secrets")).json()) as {
      secrets: SecretRow[];
    };
    expect(secrets).toEqual([]);
  });

  it("refuses a write to the collection", async () => {
    const w = await world();
    expect((await w.call("POST", "/secrets")).status).toBe(405);
  });
});
