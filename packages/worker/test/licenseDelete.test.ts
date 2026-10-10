/**
 * Licence deletion on the console API (`services/license/admin/deletion.ts`,
 * `core/licensing/licenseDelete.ts`): who may be deleted, the typed confirmation, the cascade over every
 * table keyed by the licence, the KV purge, the audit row, the bulk route and the "Clean up
 * duplicates" list.
 */
import { beforeEach, describe, expect, it } from "vitest";
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
import type { Env } from "../src/platform/env.js";
import { handleAdmin } from "../src/console/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/core/console/session.js";
import { loadProduct } from "../src/core/products.js";
import { handleActivate } from "../src/services/license/activation.js";
import { getTokenRecord, putTokenRecord } from "../src/platform/kv.js";
import { listAudit } from "../src/core/repo.js";
import { licenseDeleteFor } from "../src/core/licensing/licenseDelete.js";
import { SERVICES } from "../src/mount.js";
import { auditStatementFor } from "../src/core/console/audit.js";

const SLUG = "djdl";
const PLATFORM_GROUP = "admins";
const SUBJECT = `ps_${"s".repeat(22)}`;
const DAY = 86_400;

/**
 * Every table with a `license_id` column. A new table that holds licence ids must be claimed here
 * AND handled by a `licenseDelete` contributor (deleted, or — like `dist_purchases` and
 * `license_store_grants` — a blocker that refuses the deletion); this list is compared with
 * `sqlite_master`, so an unclaimed table fails the suite.
 */
const LICENSE_KEYED = [
  "devices",
  "dist_purchase_binding_aliases",
  "dist_purchase_bindings",
  "dist_purchases",
  // LX-08: the licence's entitlement events and the grants it holds (its `oidc` grant; a store
  // grant blocks through `license_store_grants`), deleted by Core (`core/licensing/grants.ts`).
  "entitlement_events",
  "grants",
  "keys_index",
  "license_auto_attach_blocks",
  "license_key_entries",
  "license_profiles",
  "license_refusals",
  "license_relinks",
  "license_store_grants",
  // U-03: Config's licence-override migration report.
  "override_migration_report",
  "portal_license_links",
  "registry_tokens",
].sort();

let db: SqliteDb;
let env: Env;
let call: (method: string, path: string, body?: unknown) => Promise<Response>;

beforeEach(async () => {
  db = makeTestDb();
  env = makeEnv(new KvMock(), [SLUG]);
  env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
  env.PLATFORM_ADMIN_GROUP = PLATFORM_GROUP;
  await seedProduct(db, SLUG);
  await seedTier(db, SLUG, "standard");
  const { token, session } = await issueSession(
    env,
    { sub: "u1", name: "Ada", email: "ada@x.io", groups: [PLATFORM_GROUP] },
    NOW,
  );
  call = (method, path, body) => {
    const full = `/api/products/${SLUG}${path}`;
    const headers: Record<string, string> = {
      cookie: `${ADMIN_COOKIE}=${token}`,
      [CSRF_HEADER]: session.csrf,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    return handleAdmin(
      new Request(`https://key.plrs.im/manage${full}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }) as unknown as Request,
      env,
      db,
      full.split("?")[0]!,
      { now: NOW },
    );
  };
});

/** A licence with a key; `origin`, `status`, account and tier set directly. */
async function seedLicense(
  id: string,
  opts: {
    origin?: "admin" | "oidc" | "enroll";
    status?: "active" | "disabled";
    account?: string | null;
    activatedAt?: number;
  } = {},
): Promise<string> {
  const { key } = await seedLicenseWithKey(db, SLUG, {
    id,
    tierId: "standard",
  });
  await db.run(
    `UPDATE licenses SET origin = ?, status = ?, account_id = ?, activated_at = ?
      WHERE product = ? AND id = ?`,
    opts.origin ?? "admin",
    opts.status ?? "active",
    opts.account ?? null,
    opts.activatedAt ?? NOW,
    SLUG,
    id,
  );
  return key;
}

async function seedAccount(id: string, subject: string | null): Promise<void> {
  await db.run(
    "INSERT INTO accounts (id, created_at, modified_at) VALUES (?, ?, ?)",
    id,
    NOW,
    NOW,
  );
  if (subject)
    await db.run(
      "INSERT INTO account_product_subjects (account_id, product, subject, created_at) VALUES (?, ?, ?, ?)",
      id,
      SLUG,
      subject,
      NOW,
    );
}

/** Activate a device on the licence through the real route: a device row and a KV token. */
async function activate(key: string, device: string): Promise<string> {
  const product = (await loadProduct(env, db, SLUG))!;
  const res = await handleActivate(
    mkReq("POST", { authorization: `Bearer ${key}`, "x-pkey-device": device }),
    env,
    db,
    product,
    NOW,
  );
  expect(res.status).toBe(200);
  const row = await db.first<{ token_hash: string }>(
    "SELECT token_hash FROM devices WHERE product = ? AND device_id = ?",
    SLUG,
    device,
  );
  return row!.token_hash;
}

/** One row in every other table that hangs off the licence or its devices. */
async function seedEverything(
  licenseId: string,
  device: string,
): Promise<void> {
  await db.run(
    "INSERT INTO license_profiles (product, license_id, profile_id, sort_order) VALUES (?, ?, 'p1', 0)",
    SLUG,
    licenseId,
  );
  await db.run(
    "INSERT INTO device_facts (product, device_id, os_name, updated_at) VALUES (?, ?, 'macOS', ?)",
    SLUG,
    device,
    NOW,
  );
  await db.run(
    `INSERT INTO delta_demand_devices (product, deliverable_id, from_sha256, to_sha256, device_id, strategy, seen_at)
     VALUES (?, 'app', 'a', 'b', ?, 'lazy', ?)`,
    SLUG,
    device,
    NOW,
  );
  await db.run(
    "INSERT INTO portal_accounts (id, created_at, modified_at) VALUES ('pa_1', ?, ?)",
    NOW,
    NOW,
  );
  await db.run(
    `INSERT INTO portal_license_links (account_id, product, license_id, source, created_at, last_seen_at)
     VALUES ('pa_1', ?, ?, 'oidc', ?, ?)`,
    SLUG,
    licenseId,
    NOW,
    NOW,
  );
  await db.run(
    `INSERT INTO license_relinks (product, id, license_id, to_subject, reason, actor_sub, created_at, undo_until)
     VALUES (?, 'rl_1', ?, 'ps_to', 'support ticket', 'u1', ?, ?)`,
    SLUG,
    licenseId,
    NOW,
    NOW + 3 * DAY,
  );
  await db.run(
    "INSERT INTO license_auto_attach_blocks (product, license_id, account_id, created_at) VALUES (?, ?, 'acct_removed', ?)",
    SLUG,
    licenseId,
    NOW,
  );
  // PX-W9: one device entry and one portal entry of the key-entry counter.
  await db.run(
    `INSERT INTO license_key_entries (product, license_id, id, surface, device_id, created_at)
     VALUES (?, ?, 'ke_app', 'app', ?, ?), (?, ?, 'ke_portal', 'portal', NULL, ?)`,
    SLUG,
    licenseId,
    device,
    NOW,
    SLUG,
    licenseId,
    NOW,
  );
  await db.run(
    "INSERT INTO dist_purchase_bindings (product, binding_id, license_id, created_at) VALUES (?, 'bind_1', ?, ?)",
    SLUG,
    licenseId,
    NOW,
  );
  await db.run(
    `INSERT INTO dist_purchase_binding_aliases (product, binding_id, license_id, from_license_id, created_at)
     VALUES (?, 'bind_old', ?, 'lic_retired', ?)`,
    SLUG,
    licenseId,
    NOW,
  );
  await db.run(
    `INSERT INTO registry_tokens (product, token_id, token_hash, hint, label, scopes_json, binding,
       license_id, created_by, created_at, expires_at)
     VALUES (?, 'rt_1', 'rth_1', 'pkeyr_…', 'Godot', '["read"]', 'license', ?, 'u1', ?, ?)`,
    SLUG,
    licenseId,
    NOW,
    NOW + 30 * DAY,
  );
}

async function rowsFor(table: string, licenseId: string): Promise<number> {
  const r = await db.first<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${table} WHERE license_id = ?`,
    licenseId,
  );
  return r!.n;
}

describe("licence deletion: the claimed tables", () => {
  it("every table with a license_id column is one the deletion handles", async () => {
    const rows = await db.all<{ name: string }>(
      `SELECT m.name FROM sqlite_master m JOIN pragma_table_info(m.name) p
        WHERE m.type = 'table' AND p.name = 'license_id' ORDER BY m.name`,
    );
    expect(rows.map((r) => r.name).sort()).toEqual(LICENSE_KEYED);
  });
});

describe("licence deletion: the batch guard", () => {
  it("writes nothing when a store purchase lands between the verdict and the batch", async () => {
    await seedLicense("lic_race", { origin: "oidc" });
    const collector = licenseDeleteFor(SERVICES);
    const target = { product: SLUG, licenseId: "lic_race", now: NOW };
    // The verdict was read with no purchase; then a purchase is recorded.
    expect((await collector.blockers(db, SLUG, ["lic_race"])).size).toBe(0);
    await db.run(
      `INSERT INTO dist_purchases (product, store, purchase_key_hash, store_product_id, license_id, state,
         environment, first_seen, last_verified)
       VALUES (?, 'play', 'h9', 'full', 'lic_race', 'active', 'production', ?, ?)`,
      SLUG,
      NOW,
      NOW,
    );
    const session = { sub: "u1", name: "Ada", email: "ada@x.io" } as Parameters<
      typeof auditStatementFor
    >[1];
    await db.batch([
      ...collector.statements(target),
      auditStatementFor(
        SLUG,
        session,
        NOW,
        "license.delete",
        { kind: "license", id: "lic_race" },
        "Deleted license lic_race",
        collector.guard(target),
      ),
    ]);
    expect(
      await db.first(
        "SELECT id FROM licenses WHERE product = ? AND id = 'lic_race'",
        SLUG,
      ),
    ).not.toBeNull();
    expect(await rowsFor("keys_index", "lic_race")).toBe(1);
    expect(await rowsFor("dist_purchases", "lic_race")).toBe(1);
    expect(
      (await listAudit(db, SLUG, { limit: 50 })).some(
        (a) => a.action === "license.delete",
      ),
    ).toBe(false);
  });
});

describe("DELETE …/license/licenses/<id>", () => {
  it("deletes a disabled licence and everything keyed by it, purges its tokens and audits it", async () => {
    await seedAccount("acct_1", SUBJECT);
    const key = await seedLicense("lic_dup", {
      origin: "oidc",
      account: "acct_1",
    });
    const tokenHash = await activate(key, "device-0001");
    await seedEverything("lic_dup", "device-0001");
    // Its history before the deletion: disabled by the operator.
    expect(
      (await call("POST", "/license/licenses/lic_dup/disable")).status,
    ).toBe(200);
    // A survivor's alias that names this licence as the RETIRED one is the survivor's: kept.
    await seedLicense("lic_survivor");
    await db.run(
      `INSERT INTO dist_purchase_binding_aliases (product, binding_id, license_id, from_license_id, created_at)
       VALUES (?, 'bind_dup_old', 'lic_survivor', 'lic_dup', ?)`,
      SLUG,
      NOW,
    );
    expect(await getTokenRecord(env, SLUG, tokenHash)).toBeNull(); // disable purged it
    // Put a record back so the deletion's own purge is what removes it.
    await putTokenRecord(env, SLUG, tokenHash, {
      product: SLUG,
      deviceId: "device-0001",
      licenseId: "lic_dup",
    });
    expect(await getTokenRecord(env, SLUG, tokenHash)).not.toBeNull();

    const res = await call("DELETE", "/license/licenses/lic_dup", {
      confirm: "delete lic_dup",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      id: "lic_dup",
      devices: 1,
    });

    for (const table of LICENSE_KEYED)
      expect(await rowsFor(table, "lic_dup"), table).toBe(0);
    for (const table of [
      "device_facts",
      "device_fingerprints",
      "delta_demand_devices",
    ]) {
      const r = await db.first<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${table} WHERE device_id = 'device-0001'`,
      );
      expect(r!.n, table).toBe(0);
    }
    expect(
      await db.first(
        "SELECT id FROM licenses WHERE product = ? AND id = 'lic_dup'",
        SLUG,
      ),
    ).toBeNull();
    // The survivor's alias stays and still resolves to the survivor.
    expect(
      await db.first<{ license_id: string }>(
        "SELECT license_id FROM dist_purchase_binding_aliases WHERE binding_id = 'bind_dup_old'",
      ),
    ).toEqual({ license_id: "lic_survivor" });
    // The survivor is untouched.
    expect(await rowsFor("keys_index", "lic_survivor")).toBe(1);
    expect(await getTokenRecord(env, SLUG, tokenHash)).toBeNull();

    const audit = (await listAudit(db, SLUG, { limit: 50 })).filter(
      (a) => a.target_id === "lic_dup",
    );
    const actions = audit.map((a) => a.action);
    expect(actions).toContain("license.disable"); // history kept
    const del = audit.find((a) => a.action === "license.delete")!;
    expect(del.actor_sub).toBe("u1");
    expect(del.summary).toBe(
      `Deleted license lic_dup (tier standard, origin oidc, account ${SUBJECT}, 1 device, 1 authorized)`,
    );
    // The global account id never reaches the developer-facing audit log.
    expect(JSON.stringify(audit)).not.toContain("acct_1");

    expect((await call("GET", "/license/licenses/lic_dup")).status).toBe(404);
  });

  it("deletes an active sign-in or auto-issued licence", async () => {
    await seedLicense("lic_oidc", { origin: "oidc" });
    await seedLicense("lic_enroll", { origin: "enroll" });
    for (const id of ["lic_oidc", "lic_enroll"]) {
      const res = await call("DELETE", `/license/licenses/${id}`, {
        confirm: `delete ${id}`,
      });
      expect(res.status, id).toBe(200);
    }
  });

  it("refuses an active licence the developer issued, and suggests disabling it", async () => {
    await seedLicense("lic_admin");
    const res = await call("DELETE", "/license/licenses/lic_admin", {
      confirm: "delete lic_admin",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      code: string;
      reasons: { code: string }[];
      suggestion: string;
    };
    expect(body.code).toBe("license_not_deletable");
    expect(body.reasons.map((r) => r.code)).toEqual(["issued_active"]);
    expect(body.suggestion).toBe("disable");
    expect(await rowsFor("keys_index", "lic_admin")).toBe(1);
  });

  it("refuses a licence with store grants or recorded purchases, even disabled", async () => {
    await seedLicense("lic_grant", { status: "disabled" });
    await db.run(
      `INSERT INTO license_store_grants (product, license_id, flag, store, purchase_key_hash, state, granted_at, revoked_at)
       VALUES (?, 'lic_grant', 'full', 'steam', 'h1', 'revoked', ?, ?)`,
      SLUG,
      NOW,
      NOW,
    );
    await seedLicense("lic_bought", { origin: "oidc" });
    await db.run(
      `INSERT INTO dist_purchases (product, store, purchase_key_hash, store_product_id, license_id, state,
         environment, first_seen, last_verified)
       VALUES (?, 'app-store', 'h2', 'com.x.full', 'lic_bought', 'rejected', 'production', ?, ?)`,
      SLUG,
      NOW,
      NOW,
    );
    for (const [id, code] of [
      ["lic_grant", "store_grants"],
      ["lic_bought", "store_purchases"],
    ] as const) {
      const res = await call("DELETE", `/license/licenses/${id}`, {
        confirm: `delete ${id}`,
      });
      expect(res.status, id).toBe(409);
      const body = (await res.json()) as { reasons: { code: string }[] };
      expect(
        body.reasons.map((r) => r.code),
        id,
      ).toEqual([code]);
      expect(await rowsFor("keys_index", id), id).toBe(1);
    }
  });

  it("requires the typed confirmation", async () => {
    await seedLicense("lic_x", { status: "disabled" });
    for (const body of [
      undefined,
      {},
      { confirm: "delete" },
      { confirm: "lic_x" },
    ]) {
      const res = await call("DELETE", "/license/licenses/lic_x", body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ reason: "confirm_required" });
    }
    expect(await rowsFor("keys_index", "lic_x")).toBe(1);
    expect(
      (await listAudit(db, SLUG, { limit: 50 })).some(
        (a) => a.action === "license.delete",
      ),
    ).toBe(false);
  });

  it("refuses a disabled auto-issued licence still bound to its machine (enroll guard)", async () => {
    await seedLicense("lic_free", { origin: "enroll", status: "disabled" });
    await db.run(
      "UPDATE licenses SET enroll_hwid = 'hw_1' WHERE product = ? AND id = 'lic_free'",
      SLUG,
    );
    const res = await call("DELETE", "/license/licenses/lic_free", {
      confirm: "delete lic_free",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { reasons: { code: string }[] };
    expect(body.reasons.map((r) => r.code)).toEqual(["enroll_guard"]);
    expect(await rowsFor("keys_index", "lic_free")).toBe(1);
  });

  it("audits a licence once when two deletions race", async () => {
    await seedLicense("lic_twice", { status: "disabled" });
    const [a, b] = await Promise.all([
      call("DELETE", "/license/licenses/lic_twice", {
        confirm: "delete lic_twice",
      }),
      call("DELETE", "/license/licenses/lic_twice", {
        confirm: "delete lic_twice",
      }),
    ]);
    expect([a.status, b.status].sort()).toContain(200);
    const deletes = (await listAudit(db, SLUG, { limit: 50 })).filter(
      (x) => x.action === "license.delete",
    );
    expect(deletes).toHaveLength(1);
  });

  it("refuses a session that is not a platform admin, and a write without the CSRF token", async () => {
    await seedLicense("lic_y", { status: "disabled" });
    const { token: outsider } = await issueSession(
      env,
      { sub: "u2", name: "Eve", email: "eve@x.io", groups: ["someone-else"] },
      NOW,
    );
    const { token } = await issueSession(
      env,
      { sub: "u1", name: "Ada", email: "ada@x.io", groups: [PLATFORM_GROUP] },
      NOW,
    );
    const send = (
      method: string,
      path: string,
      headers: Record<string, string>,
      body: unknown,
    ) =>
      handleAdmin(
        new Request(`https://key.plrs.im/manage/api/products/${SLUG}${path}`, {
          method,
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        }) as unknown as Request,
        env,
        db,
        `/api/products/${SLUG}${path}`,
        { now: NOW },
      );
    const cases: [string, string, unknown][] = [
      ["DELETE", "/license/licenses/lic_y", { confirm: "delete lic_y" }],
      [
        "POST",
        "/license/deletions",
        { ids: ["lic_y"], confirm: "delete 1 license" },
      ],
    ];
    for (const [method, path, body] of cases) {
      const csrfOf = (
        await issueSession(
          env,
          {
            sub: "u2",
            name: "Eve",
            email: "eve@x.io",
            groups: ["someone-else"],
          },
          NOW,
        )
      ).session.csrf;
      const denied = await send(
        method,
        path,
        { cookie: `${ADMIN_COOKIE}=${outsider}`, [CSRF_HEADER]: csrfOf },
        body,
      );
      expect(denied.status, `${method} ${path} outsider`).toBe(403);
      const noCsrf = await send(
        method,
        path,
        { cookie: `${ADMIN_COOKIE}=${token}` },
        body,
      );
      expect(noCsrf.status, `${method} ${path} no CSRF`).toBe(403);
    }
    const outsiderRead = await handleAdmin(
      new Request(
        `https://key.plrs.im/manage/api/products/${SLUG}/license/deletions/candidates`,
        { headers: { cookie: `${ADMIN_COOKIE}=${outsider}` } },
      ) as unknown as Request,
      env,
      db,
      `/api/products/${SLUG}/license/deletions/candidates`,
      { now: NOW },
    );
    expect(outsiderRead.status).toBe(403);
    expect(await rowsFor("keys_index", "lic_y")).toBe(1);
  });

  it("answers 404 for an unknown licence", async () => {
    const res = await call("DELETE", "/license/licenses/lic_nope", {
      confirm: "delete lic_nope",
    });
    expect(res.status).toBe(404);
  });

  it("carries each licence's verdict and origin on the list and the record", async () => {
    await seedLicense("lic_admin");
    await seedLicense("lic_off", { status: "disabled" });
    const list = (await (await call("GET", "/license/licenses")).json()) as {
      licenses: {
        id: string;
        origin: string;
        deletion: { allowed: boolean; reasons: { code: string }[] };
      }[];
    };
    const byId = new Map(list.licenses.map((l) => [l.id, l]));
    expect(byId.get("lic_admin")!.deletion).toMatchObject({ allowed: false });
    expect(byId.get("lic_admin")!.origin).toBe("admin");
    expect(byId.get("lic_off")!.deletion).toEqual({
      allowed: true,
      reasons: [],
    });
    const detail = (await (
      await call("GET", "/license/licenses/lic_admin")
    ).json()) as { deletion: { reasons: { code: string }[] } };
    expect(detail.deletion.reasons.map((r) => r.code)).toEqual([
      "issued_active",
    ]);
  });
});

describe("POST …/license/deletions", () => {
  it("deletes the allowed, refuses the rest with reasons, and needs the count typed", async () => {
    await seedLicense("lic_a", { status: "disabled" });
    await seedLicense("lic_b", { origin: "oidc" });
    await seedLicense("lic_admin");
    const ids = ["lic_a", "lic_b", "lic_admin", "lic_gone"];

    const wrong = await call("POST", "/license/deletions", {
      ids,
      confirm: "delete 3 licenses",
    });
    expect(wrong.status).toBe(400);

    const res = await call("POST", "/license/deletions", {
      ids,
      confirm: "delete 4 licenses",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      deleted: { id: string }[];
      refused: { id: string; reasons: { code: string }[] }[];
      notFound: string[];
    };
    expect(body.ok).toBe(false);
    expect(body.deleted.map((d) => d.id)).toEqual(["lic_a", "lic_b"]);
    expect(body.refused).toEqual([
      {
        id: "lic_admin",
        reasons: [expect.objectContaining({ code: "issued_active" })],
      },
    ]);
    expect(body.notFound).toEqual(["lic_gone"]);
    const deletes = (await listAudit(db, SLUG, { limit: 50 })).filter(
      (a) => a.action === "license.delete",
    );
    expect(deletes.map((a) => a.target_id).sort()).toEqual(["lic_a", "lic_b"]);
  });

  it("refuses an empty or oversized list", async () => {
    expect(
      (
        await call("POST", "/license/deletions", {
          ids: [],
          confirm: "delete 0 licenses",
        })
      ).status,
    ).toBe(422);
    const ids = Array.from({ length: 101 }, (_, i) => `lic_${i}`);
    expect(
      (
        await call("POST", "/license/deletions", {
          ids,
          confirm: "delete 101 licenses",
        })
      ).status,
    ).toBe(422);
  });
});

describe("GET …/license/deletions/candidates", () => {
  it("lists sign-in duplicates of a usable licence, never a licence only because it is disabled", async () => {
    // acct_1 bought a licence and the old in-app sign-in minted a duplicate.
    await seedAccount("acct_1", SUBJECT);
    await seedLicense("lic_paid", {
      account: "acct_1",
      activatedAt: NOW - 10 * DAY,
    });
    const dupKey = await seedLicense("lic_dup", {
      origin: "oidc",
      account: "acct_1",
    });
    await activate(dupKey, "device-dup");
    // acct_2 holds two sign-in licences: the older stays, the newer is the duplicate.
    await seedAccount("acct_2", null);
    await seedLicense("lic_first", {
      origin: "oidc",
      account: "acct_2",
      activatedAt: NOW - 5 * DAY,
    });
    await seedLicense("lic_second", { origin: "oidc", account: "acct_2" });
    // Disabled sign-in licences without another licence on their account are NOT listed: deleting
    // one would let its holder sign in for a new one, so that is a decision for its record.
    const oldKey = await seedLicense("lic_dormant", { origin: "oidc" });
    await activate(oldKey, "device-dormant");
    await db.run(
      "UPDATE devices SET last_seen = ? WHERE device_id = 'device-dormant'",
      NOW - 60 * DAY,
    );
    await db.run(
      "UPDATE licenses SET status = 'disabled' WHERE id = 'lic_dormant'",
    );
    const recentKey = await seedLicense("lic_recent", { origin: "oidc" });
    await activate(recentKey, "device-recent");
    await db.run(
      "UPDATE devices SET last_seen = ? WHERE device_id = 'device-recent'",
      NOW - DAY,
    );
    await db.run(
      "UPDATE licenses SET status = 'disabled' WHERE id = 'lic_recent'",
    );
    // A lone active sign-in licence: nothing to clean up.
    await seedLicense("lic_alone", { origin: "oidc" });
    // A duplicate with a store purchase: listed, but not deletable.
    await seedAccount("acct_3", null);
    await seedLicense("lic_keep3", { account: "acct_3" });
    await seedLicense("lic_dup3", { origin: "oidc", account: "acct_3" });
    await db.run(
      `INSERT INTO dist_purchases (product, store, purchase_key_hash, store_product_id, license_id, state,
         environment, first_seen, last_verified)
       VALUES (?, 'steam', 'h3', 'full', 'lic_dup3', 'active', 'production', ?, ?)`,
      SLUG,
      NOW,
      NOW,
    );

    const res = await call("GET", "/license/deletions/candidates");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      candidates: {
        id: string;
        reason: string;
        keeps: string | null;
        accountSubject: string | null;
        deviceCount: number;
        deletion: { allowed: boolean; reasons: { code: string }[] };
      }[];
    };
    const byId = new Map(body.candidates.map((c) => [c.id, c]));
    expect([...byId.keys()].sort()).toEqual(
      ["lic_dup", "lic_dup3", "lic_second"].sort(),
    );
    expect(byId.get("lic_dup")).toMatchObject({
      reason: "duplicate",
      keeps: "lic_paid",
      deviceCount: 1,
      accountSubject: SUBJECT,
      deletion: { allowed: true },
    });
    expect(byId.get("lic_second")).toMatchObject({
      reason: "duplicate",
      keeps: "lic_first",
      accountSubject: null,
    });
    expect(byId.get("lic_dup3")!.deletion.allowed).toBe(false);
    expect(byId.get("lic_dup3")!.deletion.reasons.map((r) => r.code)).toEqual([
      "store_purchases",
    ]);
    expect(JSON.stringify(body)).not.toMatch(/acct_/);

    // The helper's delete: the allowed candidates, one typed confirmation with the count.
    const allowed = body.candidates
      .filter((c) => c.deletion.allowed)
      .map((c) => c.id);
    const del = await call("POST", "/license/deletions", {
      ids: allowed,
      confirm: `delete ${allowed.length} licenses`,
    });
    expect(((await del.json()) as { deleted: unknown[] }).deleted).toHaveLength(
      2,
    );
    const after = (await (
      await call("GET", "/license/deletions/candidates")
    ).json()) as { candidates: { id: string }[] };
    expect(after.candidates.map((c) => c.id)).toEqual(["lic_dup3"]);
  });
});
