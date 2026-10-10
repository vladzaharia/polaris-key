/**
 * LX-08 (plans/LX-01.md §6.1–6.2, notes/S-19 §7.14 steps 1–4): the licensing model's expand,
 * backfill, dual-write and the provisioned-keys move.
 *
 *   1. The migrations, rehearsed on a production-shaped copy (the database as it stands before
 *      them, with store grants in every state): the backfill projects them exactly (zero drift),
 *      a replay of every replayable file writes nothing, and the rollback script hands an old
 *      Worker the moved keys back, byte for byte.
 *   2. The provisioned-keys move: `legacy` documents are byte-identical (signed bytes and ETag)
 *      before and after it, a move that would reorder keys is deferred to the next sign-in, a pass
 *      is idempotent and loses no race, and a sign-in moves its own licence.
 *   3. The catch-up converges what a pre-LX-08 Worker writes in the deploy window.
 *   4. The highest-rank group choice and `syncTierOnSignIn: upgradeOnly`.
 *   5. The new rows go with a deleted licence, an erased product and an absorbed subject.
 *
 * The dual-write's reconciliation runs across every commerce scenario: `test/commerce.test.ts` and
 * `test/licenseMerge.test.ts` assert zero drift (`storeGrantDrift`) after each one.
 */
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SqliteDb } from "../src/db/sqlite.js";
import type { Db } from "../src/db/types.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, mkReq, NOW, seedProduct, seedTier } from "./seed.js";
import { loadProduct } from "../src/core/products.js";
import {
  moveProvisionedKeys,
  oidcGrantStatements,
  planProvisionedMove,
  storeGrantDrift,
} from "../src/core/grants.js";
import { runLicensingCatchUp } from "../src/core/licensingCatchUp.js";
import { resolveMergedPayload } from "../src/core/payload.js";
import { getLicense } from "../src/repo.js";
import { SERVICES } from "../src/mount.js";
import {
  activateFromIdentity,
  authorizeAndMint,
  mergeProvisionedOverrides,
  type OidcIdentity,
} from "../src/services/identity/oidc.js";
import { handleLicenseDocument } from "../src/services/license/document.js";
import { licenseDeleteFor } from "../src/core/licenseDelete.js";
import { deleteProduct } from "../src/admin/repo.js";
import { entitlementEventStore } from "../src/core/entitlementEvents.js";
import { subjectStores } from "../src/core/subjectHooks.js";
import type { Env } from "../src/env.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "..", "migrations");
const FILES = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const LX08 = FILES.filter((f) => f.startsWith("0105_"));
const BEFORE = FILES.filter((f) => !f.startsWith("0105_"));
const sql = (f: string) => readFileSync(join(DIR, f), "utf8");
const DOWN = readFileSync(
  join(HERE, "..", "scripts", "rollback", "0105_licensing.down.sql"),
  "utf8",
);
const SLUG = "djdl";

/** Run the rollback script as `wrangler d1 execute --file` does: every statement, in order. */
function runDown(db: SqliteDb): void {
  (db as unknown as { db: Database.Database }).db.exec(DOWN);
}

/** `db` with D1's limit of 100 bound parameters per statement enforced (better-sqlite3 allows
 *  thousands), so a statement that binds one parameter per declared key fails here as on D1. */
function d1Limited(db: SqliteDb): Db {
  const check = (params: readonly unknown[]) => {
    if (params.length > 100)
      throw new Error(`too many SQL variables (${params.length})`);
  };
  return {
    all: (q, ...p) => (check(p), db.all(q, ...p)),
    first: (q, ...p) => (check(p), db.first(q, ...p)),
    run: (q, ...p) => (check(p), db.run(q, ...p)),
    runChanges: (q, ...p) => (check(p), db.runChanges(q, ...p)),
    batch: (st) => (st.forEach((x) => check(x.params)), db.batch(st)),
    batchChanges: (st) => (
      st.forEach((x) => check(x.params)),
      db.batchChanges(st)
    ),
  };
}

/** Every row of the licensing model's tables (and the old ones the backfill reads), for a replay
 *  comparison. */
async function dump(db: Db): Promise<string> {
  const tables = [
    "grants",
    "grant_entitlements",
    "dist_purchases",
    "dist_store_product_entitlements",
    "license_store_grants",
    "licenses",
    "tiers",
  ];
  const out: Record<string, unknown> = {};
  for (const t of tables)
    out[t] = await db.all(`SELECT * FROM ${t} ORDER BY 1, 2, 3`);
  return JSON.stringify(out);
}

// ── 1. the migrations ────────────────────────────────────────────────────────────────────────

describe("the LX-08 migrations on a production-shaped copy", () => {
  async function productionShaped(): Promise<{
    raw: Database.Database;
    db: SqliteDb;
  }> {
    const raw = new Database(":memory:");
    expect(raw.pragma("foreign_keys", { simple: true })).toBe(1);
    for (const f of BEFORE) raw.exec(sql(f));
    const db = new SqliteDb(raw);
    await seedProduct(db, "acme");
    const run = (q: string, ...p: unknown[]) => raw.prepare(q).run(...p);
    run(
      `INSERT INTO tiers (product, id, label, modified_at) VALUES ('acme', 'std', 'Standard', ?)`,
      NOW,
    );
    for (const id of ["lic_1", "lic_2"])
      run(
        `INSERT INTO licenses (product, id, status, activated_at, modified_at)
         VALUES ('acme', ?, 'active', ?, ?)`,
        id,
        NOW,
        NOW,
      );
    for (const [store, sp, flag] of [
      ["steam", "111", "dlc.a"],
      ["app-store", "com.acme.pro", "pro.unlock"],
      ["play", "sku.b", "dlc.b"],
    ])
      run(
        `INSERT INTO dist_store_products
           (product, store, store_product_id, deliverable_id, flag, modified_at, modified_by)
         VALUES ('acme', ?, ?, 'app', ?, ?, 'op')`,
        store,
        sp,
        flag,
        NOW,
      );
    // h1: active. h2: refunded. h3: active, granted under a mapping that was later changed (its
    // old flag revoked by a refund, then re-granted under the new flag). h4: pending, no grant.
    for (const [store, hash, sp, lic, state] of [
      ["steam", "h1", "111", "lic_1", "active"],
      ["app-store", "h2", "com.acme.pro", "lic_1", "revoked"],
      ["play", "h3", "sku.b", "lic_2", "active"],
      ["play", "h4", "sku.b", "lic_2", "pending"],
    ])
      run(
        `INSERT INTO dist_purchases
           (product, store, purchase_key_hash, store_product_id, license_id, state, environment,
            first_seen, last_verified)
         VALUES ('acme', ?, ?, ?, ?, ?, 'Production', ?, ?)`,
        store,
        hash,
        sp,
        lic,
        state,
        NOW,
        NOW,
      );
    for (const [lic, flag, store, hash, state, at, revokedAt] of [
      ["lic_1", "dlc.a", "steam", "h1", "active", NOW + 10, null],
      ["lic_1", "pro.unlock", "app-store", "h2", "revoked", NOW + 20, NOW + 30],
      ["lic_2", "dlc.b", "play", "h3", "active", NOW + 40, null],
      ["lic_2", "old.flag", "play", "h3", "revoked", NOW + 5, NOW + 35],
    ] as const)
      run(
        `INSERT INTO license_store_grants
           (product, license_id, flag, store, purchase_key_hash, state, granted_at, revoked_at)
         VALUES ('acme', ?, ?, ?, ?, ?, ?, ?)`,
        lic,
        flag,
        store,
        hash,
        state,
        at,
        revokedAt,
      );
    return { raw, db };
  }

  it("expands additively and projects every store grant exactly (zero drift)", async () => {
    const { raw, db } = await productionShaped();
    const licensesBefore = await db.all(
      "SELECT * FROM licenses ORDER BY product, id",
    );
    const oldBefore = await db.all(
      "SELECT * FROM license_store_grants ORDER BY 1, 2, 3, 4, 5",
    );
    for (const f of LX08) raw.exec(sql(f));

    // Old objects untouched; new columns at their defaults.
    expect(
      await db.all("SELECT * FROM license_store_grants ORDER BY 1, 2, 3, 4, 5"),
    ).toEqual(oldBefore);
    const licensesAfter = await db.all<Record<string, unknown>>(
      "SELECT * FROM licenses ORDER BY product, id",
    );
    expect(
      licensesAfter.map((l) => ({
        ...l,
        kind: undefined,
        ended_reason: undefined,
        superseded_by: undefined,
        source: undefined,
        external_ref_hash: undefined,
      })),
    ).toEqual(
      (licensesBefore as Record<string, unknown>[]).map((l) => ({
        ...l,
        kind: undefined,
        ended_reason: undefined,
        superseded_by: undefined,
        source: undefined,
        external_ref_hash: undefined,
      })),
    );
    expect(licensesAfter.map((l) => l.kind)).toEqual(["base", "base"]);

    expect(
      await db.all(
        `SELECT id, license_id, source, external_ref_hash, sku, state, granted_at, modified_at,
                created_by FROM grants ORDER BY id`,
      ),
    ).toEqual([
      {
        id: "grt_s_app-store_h2",
        license_id: "lic_1",
        source: "app-store",
        external_ref_hash: "h2",
        sku: "com.acme.pro",
        state: "revoked",
        granted_at: NOW + 20,
        modified_at: NOW + 30,
        created_by: "migration",
      },
      {
        id: "grt_s_play_h3",
        license_id: "lic_2",
        source: "play",
        external_ref_hash: "h3",
        sku: "sku.b",
        state: "active",
        granted_at: NOW + 5,
        modified_at: NOW + 40,
        created_by: "migration",
      },
      {
        id: "grt_s_steam_h1",
        license_id: "lic_1",
        source: "steam",
        external_ref_hash: "h1",
        sku: "111",
        state: "active",
        granted_at: NOW + 10,
        modified_at: NOW + 10,
        created_by: "migration",
      },
    ]);
    // An active grant carries its active flags only (the remapped flag a refund revoked stays
    // out, as the legacy layer leaves it out); a revoked grant keeps its keys as history.
    expect(
      await db.all(
        "SELECT grant_id, key, value_json, state, updated_at FROM grant_entitlements ORDER BY grant_id, key",
      ),
    ).toEqual([
      {
        grant_id: "grt_s_app-store_h2",
        key: "pro.unlock",
        value_json: "true",
        state: "default",
        updated_at: NOW + 20,
      },
      {
        grant_id: "grt_s_play_h3",
        key: "dlc.b",
        value_json: "true",
        state: "default",
        updated_at: NOW + 40,
      },
      {
        grant_id: "grt_s_steam_h1",
        key: "dlc.a",
        value_json: "true",
        state: "default",
        updated_at: NOW + 10,
      },
    ]);
    expect(
      await db.all(
        "SELECT purchase_key_hash, grant_id FROM dist_purchases ORDER BY purchase_key_hash",
      ),
    ).toEqual([
      { purchase_key_hash: "h1", grant_id: "grt_s_steam_h1" },
      { purchase_key_hash: "h2", grant_id: "grt_s_app-store_h2" },
      { purchase_key_hash: "h3", grant_id: "grt_s_play_h3" },
      { purchase_key_hash: "h4", grant_id: null },
    ]);
    expect(
      await db.all(
        "SELECT store, store_product_id, key, value_json FROM dist_store_product_entitlements ORDER BY store",
      ),
    ).toEqual([
      {
        store: "app-store",
        store_product_id: "com.acme.pro",
        key: "pro.unlock",
        value_json: "true",
      },
      {
        store: "play",
        store_product_id: "sku.b",
        key: "dlc.b",
        value_json: "true",
      },
      {
        store: "steam",
        store_product_id: "111",
        key: "dlc.a",
        value_json: "true",
      },
    ]);
    expect(
      await db.all(
        "SELECT DISTINCT rank, policy_offline_grace_days FROM tiers",
      ),
    ).toEqual([{ rank: 0, policy_offline_grace_days: null }]);
    expect(await storeGrantDrift(db, "acme")).toEqual([]);
  });

  it("replays: every replayable file writes nothing again; an ALTER file stops at itself", async () => {
    const { raw, db } = await productionShaped();
    for (const f of LX08) raw.exec(sql(f));
    const once = await dump(db);
    for (const f of LX08) {
      if (/^0105_[b-k]_/.test(f)) {
        // R11-04: one bare ADD COLUMN per file, so a replay fails here and strands nothing.
        expect(() => raw.exec(sql(f))).toThrow(/duplicate column/);
        continue;
      }
      raw.exec(sql(f));
    }
    expect(await dump(db)).toBe(once);
    // The catch-up's upsert form of the same projection converges on the same rows.
    await runLicensingCatchUp(db, SERVICES, NOW);
    expect(await dump(db)).toBe(once);
  });

  it("the vocabularies are enforced and the holder is exactly one", async () => {
    const { raw, db } = await productionShaped();
    for (const f of LX08) raw.exec(sql(f));
    const grant = (
      source: string,
      state: string,
      holders: [unknown, unknown],
    ) =>
      db.run(
        `INSERT INTO grants (product, id, account_id, license_id, source, state, granted_at,
           created_by, modified_at, modified_by)
         VALUES ('acme', ?, ?, ?, ?, ?, 1, 't', 1, 't')`,
        `grt_${source}_${state}_${String(holders[0])}`,
        holders[0] as string | null,
        holders[1] as string | null,
        source,
        state,
      );
    await expect(grant("direct", "active", [null, "lic_1"])).rejects.toThrow(
      /grants.source/,
    );
    await expect(grant("polaris-key", "gone", [null, "lic_1"])).rejects.toThrow(
      /grants.state/,
    );
    await expect(grant("comp", "active", ["acct", "lic_1"])).rejects.toThrow(
      /CHECK/,
    );
    await expect(grant("comp", "active", [null, null])).rejects.toThrow(
      /CHECK/,
    );
    await grant("polaris-key", "past_due", [null, "lic_1"]);
    await expect(
      db.run(
        "UPDATE licenses SET ended_reason = 'lost' WHERE product = 'acme' AND id = 'lic_1'",
      ),
    ).rejects.toThrow(/ended_reason/);
    await db.run(
      "UPDATE licenses SET status = 'disabled', ended_reason = 'refunded' WHERE product = 'acme' AND id = 'lic_1'",
    );
    await expect(
      db.run("UPDATE licenses SET kind = 'bonus' WHERE product = 'acme'"),
    ).rejects.toThrow(/CHECK/);
  });
});

// ── 2. the provisioned-keys move ─────────────────────────────────────────────────────────────

async function seedOidc(db: Db, hooks: string[] = ["polarisVpn"]) {
  await db.run(
    "INSERT INTO oidc_config (product, provider, issuer, client_id, client_secret_secret, redirect_uris_json, group_role_map_json) VALUES (?,?,?,?,?,?,?)",
    SLUG,
    "custom",
    "https://id.example",
    "client-djdl",
    null,
    JSON.stringify(["https://key.plrs.im/djdl/identity/auth/callback"]),
    JSON.stringify({
      members: { role: "user", tier: "pro" },
      vip: { role: "user", tier: "gold" },
    }),
  );
  await seedTier(db, SLUG, "pro", { deviceLimit: 5 });
  await seedTier(db, SLUG, "gold", { deviceLimit: 5 });
  for (const key of hooks)
    await db.run(
      "INSERT INTO provisioning_config (product, claim, entitlement_key, entitlement_value_json, secret_key, secret_url_template, allowed_hosts_json) VALUES (?,?,?,?,?,?,?)",
      SLUG,
      key === hooks[0] ? "vpnSub" : `${key}.claim`,
      key,
      JSON.stringify(true),
      key === hooks[0] ? "proxy.subscriptionUrl" : null,
      key === hooks[0] ? "https://vpn.example.com/{claim}" : null,
      JSON.stringify(["vpn.example.com"]),
    );
}

const identity = (over: Partial<OidcIdentity> = {}): OidcIdentity => ({
  sub: "user-123",
  email: "ada@example.com",
  name: "Ada Lovelace",
  groups: ["members"],
  claims: { sub: "user-123", vpnSub: "abc123" },
  ...over,
});

interface World {
  db: SqliteDb;
  env: Env;
  product: NonNullable<Awaited<ReturnType<typeof loadProduct>>>;
  licenseId: string;
  token: string;
}

async function world(hooks?: string[]): Promise<World> {
  const db = makeTestDb();
  const env = makeEnv(new KvMock(), [SLUG]);
  await seedProduct(db, SLUG);
  await seedOidc(db, hooks);
  const product = (await loadProduct(env, db, SLUG))!;
  const r = await activateFromIdentity(db, product, identity(), NOW);
  if (!("licenseId" in r)) throw new Error("expected a licence");
  const token = await authorizeAndMint(
    env,
    db,
    product,
    r.licenseId,
    "dev-1",
    NOW,
  );
  return { db, env, product, licenseId: r.licenseId, token };
}

/** The licence document's signed bytes and ETag at `at` (Ed25519 is deterministic). */
async function document(w: World, at: number) {
  const res = await handleLicenseDocument(
    mkReq("GET", {
      authorization: `Bearer ${w.token}`,
      "x-pkey-version": "1.2.3",
    }),
    w.env,
    w.db,
    w.product,
    at,
  );
  expect(res.status).toBe(200);
  return { body: await res.text(), etag: res.headers.get("etag") };
}

/**
 * Put the licence back in its pre-LX-08 shape: the provisioned keys in its column exactly as
 * LX-02's sign-in writer left them (after every other key), no `oidc` grant, and `extra` operator
 * keys stored before them.
 */
async function preLx08(
  w: World,
  extra: Record<string, unknown> = {},
  provisioned: Record<string, unknown> = {
    polarisVpn: { state: "enforced", value: true, updatedAt: NOW },
  },
) {
  await w.db.run(
    "DELETE FROM grant_entitlements WHERE product = ? AND grant_id = ?",
    SLUG,
    `grt_oidc_${w.licenseId}`,
  );
  await w.db.run(
    "DELETE FROM grants WHERE product = ? AND id = ?",
    SLUG,
    `grt_oidc_${w.licenseId}`,
  );
  const lic = await getLicense(w.db, SLUG, w.licenseId);
  const column = JSON.parse(lic!.overrides_json!) as Record<string, unknown>;
  await w.db.run(
    "UPDATE licenses SET overrides_json = ? WHERE product = ? AND id = ?",
    JSON.stringify({
      ...column,
      entitlements: { ...extra, ...provisioned },
    }),
    SLUG,
    w.licenseId,
  );
}

/** The signed document's `entitlements` (the compact JWS's payload segment). */
const entitlementsOf = (jws: string) =>
  (
    JSON.parse(
      Buffer.from(jws.split(".")[1]!, "base64url").toString("utf8"),
    ) as {
      entitlements: Record<string, { value: unknown }>;
    }
  ).entitlements;

const column = async (w: World) =>
  JSON.parse((await getLicense(w.db, SLUG, w.licenseId))!.overrides_json!) as {
    entitlements: Record<string, unknown>;
    secrets: Record<string, unknown>;
  };

const grantKeys = async (w: World) =>
  (
    await w.db.all<{ key: string }>(
      "SELECT key FROM grant_entitlements WHERE product = ? AND grant_id = ? ORDER BY key",
      SLUG,
      `grt_oidc_${w.licenseId}`,
    )
  ).map((r) => r.key);

describe("the provisioned-keys move (S-19 §7.14 step 4)", () => {
  it("keeps a legacy document byte-identical, signed bytes and ETag, and is idempotent", async () => {
    const w = await world();
    await preLx08(w, {
      betaAccess: { state: "enforced", value: true, updatedAt: NOW - 5 },
    });
    const modifiedBefore = (await getLicense(w.db, SLUG, w.licenseId))!
      .modified_at;
    const before = await document(w, NOW + 100);
    expect(entitlementsOf(before.body)).toHaveProperty("polarisVpn");

    const r1 = await moveProvisionedKeys(w.db, NOW + 50);
    expect(r1).toEqual({ moved: 1, deferred: 0, raced: 0, more: false });
    expect(Object.keys((await column(w)).entitlements)).toEqual(["betaAccess"]);
    expect(await grantKeys(w)).toEqual(["polarisVpn"]);
    // No document byte changes, so the licence's `modified_at` (the injected entries' updatedAt)
    // is not bumped either.
    expect((await getLicense(w.db, SLUG, w.licenseId))!.modified_at).toBe(
      modifiedBefore,
    );
    expect(await document(w, NOW + 100)).toEqual(before);

    const again = await moveProvisionedKeys(w.db, NOW + 60);
    expect(again).toEqual({ moved: 0, deferred: 0, raced: 0, more: false });
    expect(await document(w, NOW + 100)).toEqual(before);
  });

  it("several provisioned keys, and a grant that already holds some, stay byte-identical", async () => {
    const w = await world(["polarisVpn", "beta.lab"]);
    await preLx08(
      w,
      { aOperator: { state: "default", value: 3, updatedAt: NOW - 9 } },
      {
        "beta.lab": { state: "enforced", value: true, updatedAt: NOW },
        polarisVpn: { state: "enforced", value: true, updatedAt: NOW },
      },
    );
    const before = await document(w, NOW + 100);
    expect((await moveProvisionedKeys(w.db, NOW + 50)).moved).toBe(1);
    expect(await grantKeys(w)).toEqual(["beta.lab", "polarisVpn"]);
    expect(await document(w, NOW + 100)).toEqual(before);
  });

  it("defers a licence whose column the move would reorder, to its next sign-in", async () => {
    const w = await world();
    // An operator key stored AFTER the provisioned key (added after the last sign-in).
    const lic = await getLicense(w.db, SLUG, w.licenseId);
    const col = JSON.parse(lic!.overrides_json!) as Record<string, unknown>;
    await preLx08(w);
    await w.db.run(
      "UPDATE licenses SET overrides_json = ? WHERE product = ? AND id = ?",
      JSON.stringify({
        ...col,
        entitlements: {
          polarisVpn: { state: "enforced", value: true, updatedAt: NOW },
          zOperator: { state: "enforced", value: 1, updatedAt: NOW },
        },
      }),
      SLUG,
      w.licenseId,
    );
    const before = await document(w, NOW + 100);
    expect(await moveProvisionedKeys(w.db, NOW + 50)).toEqual({
      moved: 0,
      deferred: 1,
      raced: 0,
      more: false,
    });
    expect(await grantKeys(w)).toEqual([]);
    expect(await document(w, NOW + 100)).toEqual(before);

    // The next sign-in moves it (and rewrites the document, as every sign-in does).
    await activateFromIdentity(w.db, w.product, identity(), NOW + 200);
    expect(Object.keys((await column(w)).entitlements)).toEqual(["zOperator"]);
    expect(await grantKeys(w)).toEqual(["polarisVpn"]);
    const ents = entitlementsOf((await document(w, NOW + 300)).body);
    expect(ents.polarisVpn?.value).toBe(true);
    expect(ents.zOperator?.value).toBe(1);
  });

  it("plans: an entry stored in another shape is not moved; a column without declared keys is left", () => {
    const declared = new Set(["vpn"]);
    expect(planProvisionedMove(null, declared, [])).toBeNull();
    expect(
      planProvisionedMove(
        JSON.stringify({
          entitlements: { other: { state: "default", value: 1 } },
        }),
        declared,
        [],
      ),
    ).toBeNull();
    // `value` before `state`: the grant would render it in another member order.
    const reordered = planProvisionedMove(
      JSON.stringify({
        entitlements: { vpn: { value: true, state: "enforced", updatedAt: 1 } },
      }),
      declared,
      [],
    );
    expect(reordered?.exact).toBe(false);
    const noStamp = planProvisionedMove(
      JSON.stringify({
        entitlements: { vpn: { state: "enforced", value: true } },
      }),
      declared,
      [],
    );
    expect(noStamp?.exact).toBe(false);
    const ok = planProvisionedMove(
      JSON.stringify({
        config: { c: 1 },
        entitlements: {
          a: { state: "default", value: 1, updatedAt: 1 },
          vpn: { state: "enforced", value: true, updatedAt: 2 },
        },
      }),
      declared,
      [],
    );
    expect(ok).toEqual({
      overridesJson: JSON.stringify({
        config: { c: 1 },
        entitlements: { a: { state: "default", value: 1, updatedAt: 1 } },
      }),
      entries: { vpn: { state: "enforced", value: true, updatedAt: 2 } },
      exact: true,
    });
  });

  it("moves only OIDC licences: an admin licence's override of a declared key stays in its column", async () => {
    const w = await world();
    const operator = {
      config: {},
      secrets: {},
      entitlements: {
        polarisVpn: { state: "enforced", value: false, updatedAt: NOW - 1 },
      },
    };
    await w.db.run(
      `INSERT INTO licenses (product, id, status, activated_at, overrides_json, origin, modified_at)
       VALUES (?, 'lic_admin', 'active', ?, ?, 'admin', ?)`,
      SLUG,
      NOW,
      JSON.stringify(operator),
      NOW,
    );
    expect(await moveProvisionedKeys(w.db, NOW + 50)).toMatchObject({
      moved: 0,
      deferred: 0,
    });
    expect((await getLicense(w.db, SLUG, "lic_admin"))!.overrides_json).toBe(
      JSON.stringify(operator),
    );
    expect(
      await w.db.first(
        "SELECT COUNT(*) AS n FROM grants WHERE product = ? AND license_id = 'lic_admin'",
        SLUG,
      ),
    ).toEqual({ n: 0 });
  });

  it("binds the declared keys as one parameter: more than 100 of them stay within D1's limit", async () => {
    const keys = [
      "polarisVpn",
      ...Array.from({ length: 120 }, (_, i) => `k${i}`),
    ];
    const w = await world(keys);
    const db = d1Limited(w.db);
    // A sign-in rewrites the grant's declared keys, and the move scans for all of them.
    await activateFromIdentity(db, w.product, identity(), NOW + 10);
    expect(await grantKeys(w)).toEqual(["polarisVpn"]);
    await preLx08(w);
    expect((await moveProvisionedKeys(db, NOW + 20)).moved).toBe(1);
    expect(await grantKeys(w)).toEqual(["polarisVpn"]);
  });

  it("loses no race: a column that changed between the read and the write is left for the next pass", async () => {
    const w = await world();
    await preLx08(w);
    let injected = false;
    const racing: Db = {
      all: w.db.all.bind(w.db),
      first: w.db.first.bind(w.db),
      run: w.db.run.bind(w.db),
      runChanges: w.db.runChanges.bind(w.db),
      async batch(statements) {
        if (!injected) {
          injected = true;
          const col = await column(w);
          await w.db.run(
            "UPDATE licenses SET overrides_json = ? WHERE product = ? AND id = ?",
            JSON.stringify({
              ...col,
              entitlements: {
                opEdit: { state: "enforced", value: 7, updatedAt: 3 },
                ...col.entitlements,
              },
            }),
            SLUG,
            w.licenseId,
          );
        }
        return w.db.batch(statements);
      },
    };
    expect(await moveProvisionedKeys(racing, NOW + 50)).toEqual({
      moved: 0,
      deferred: 0,
      raced: 1,
      more: false,
    });
    expect(await grantKeys(w)).toEqual([]);
    expect(Object.keys((await column(w)).entitlements)).toEqual([
      "opEdit",
      "polarisVpn",
    ]);
    expect((await moveProvisionedKeys(w.db, NOW + 60)).moved).toBe(1);
    expect(Object.keys((await column(w)).entitlements)).toEqual(["opEdit"]);
  });

  it("stops at its budget and the next pass finishes", async () => {
    const w = await world();
    await preLx08(w);
    expect(await moveProvisionedKeys(w.db, NOW + 50, 0)).toEqual({
      moved: 0,
      deferred: 0,
      raced: 0,
      more: true,
    });
    expect((await moveProvisionedKeys(w.db, NOW + 50)).moved).toBe(1);
  });

  it("an operator's override of a provisioned key still wins over the grant", async () => {
    const w = await world();
    const col = await column(w);
    await w.db.run(
      "UPDATE licenses SET overrides_json = ? WHERE product = ? AND id = ?",
      JSON.stringify({
        ...col,
        entitlements: {
          polarisVpn: { state: "enforced", value: false, updatedAt: NOW + 1 },
        },
      }),
      SLUG,
      w.licenseId,
    );
    const lic = (await getLicense(w.db, SLUG, w.licenseId))!;
    const { payload } = await resolveMergedPayload(w.db, SLUG, lic, null, NOW);
    expect(payload.entitlements.polarisVpn).toEqual({
      state: "enforced",
      value: false,
      updatedAt: NOW + 1,
    });
  });

  it("the rollback script hands an old Worker the moved keys, byte for byte, and empties the grants", async () => {
    const w = await world(["polarisVpn", "beta.lab"]);
    await preLx08(
      w,
      { aOperator: { state: "default", value: 3, updatedAt: NOW - 9 } },
      {
        "beta.lab": { state: "enforced", value: true, updatedAt: NOW },
        polarisVpn: { state: "enforced", value: true, updatedAt: NOW },
      },
    );
    await moveProvisionedKeys(w.db, NOW + 50);
    const lic = (await getLicense(w.db, SLUG, w.licenseId))!;
    const lx08 = await resolveMergedPayload(w.db, SLUG, lic, null, NOW);

    runDown(w.db);
    const rolled = (await getLicense(w.db, SLUG, w.licenseId))!;
    // The old Worker's composition: the column alone, no `oidc` grant layer.
    const old = await resolveMergedPayload(w.db, SLUG, rolled, null, NOW, {
      withoutOidcGrant: true,
    });
    expect(JSON.stringify(old.payload)).toBe(JSON.stringify(lx08.payload));
    // The column is the only source again: no `oidc` grant entry, no emptied grant row.
    expect(await grantKeys(w)).toEqual([]);
    expect(
      await w.db.first(
        "SELECT COUNT(*) AS n FROM grants WHERE source = 'oidc'",
      ),
    ).toEqual({ n: 0 });
    // Idempotent: a second run copies and deletes nothing.
    const once = rolled.overrides_json;
    runDown(w.db);
    expect((await getLicense(w.db, SLUG, w.licenseId))!.overrides_json).toBe(
      once,
    );
  });

  it("a key the old Worker revoked after a rollback stays revoked when LX-08 rolls forward", async () => {
    const w = await world();
    // The deployed LX-08 Worker: the key lives on the `oidc` grant.
    expect(await grantKeys(w)).toEqual(["polarisVpn"]);
    runDown(w.db);
    expect(Object.keys((await column(w)).entitlements)).toEqual(["polarisVpn"]);

    // The old (LX-02) Worker: the claim disappears at a sign-in, so its rewrite drops the
    // declared key from the column.
    const before = (await getLicense(w.db, SLUG, w.licenseId))!.overrides_json;
    await w.db.run(
      "UPDATE licenses SET overrides_json = ? WHERE product = ? AND id = ?",
      mergeProvisionedOverrides(
        before,
        { config: {}, secrets: {}, entitlements: {} },
        {
          entitlements: new Set(["polarisVpn"]),
          secrets: new Set(["proxy.subscriptionUrl"]),
        },
      ),
      SLUG,
      w.licenseId,
    );

    // Roll forward: nothing brings the revoked key back, neither the document nor the catch-up.
    const forward = async () =>
      (
        await resolveMergedPayload(
          w.db,
          SLUG,
          (await getLicense(w.db, SLUG, w.licenseId))!,
          null,
          NOW,
        )
      ).payload.entitlements;
    expect(await forward()).not.toHaveProperty("polarisVpn");
    await runLicensingCatchUp(w.db, SERVICES, NOW + 100);
    expect(await forward()).not.toHaveProperty("polarisVpn");
    expect(await grantKeys(w)).toEqual([]);
  });
});

describe("the sign-in writer (S-19 §7.14 step 4)", () => {
  it("writes provisioned entitlements to the oidc grant, never the column, and revokes on claim loss", async () => {
    const w = await world();
    expect((await column(w)).entitlements).toEqual({});
    expect(await grantKeys(w)).toEqual(["polarisVpn"]);
    await activateFromIdentity(
      w.db,
      w.product,
      identity({ claims: { sub: "user-123" } }),
      NOW + 10,
    );
    expect(await grantKeys(w)).toEqual([]);
    expect(
      entitlementsOf((await document(w, NOW + 20)).body),
    ).not.toHaveProperty("polarisVpn");
  });

  it("a sign-in on a pre-LX-08 licence moves its own keys", async () => {
    const w = await world();
    await preLx08(w, {
      betaAccess: { state: "enforced", value: true, updatedAt: NOW - 5 },
    });
    await activateFromIdentity(w.db, w.product, identity(), NOW + 10);
    expect(Object.keys((await column(w)).entitlements)).toEqual(["betaAccess"]);
    expect(await grantKeys(w)).toEqual(["polarisVpn"]);
  });

  it("a fresh licence's document matches what LX-02 minted, byte for byte", async () => {
    const w = await world();
    const now = NOW + 100;
    const lx08 = await document(w, now);
    // The same licence as LX-02 stored it: the provisioned entitlement in the column.
    const provisioned = {
      config: {},
      secrets: {},
      entitlements: {
        polarisVpn: { state: "enforced" as const, value: true, updatedAt: NOW },
      },
    };
    await preLx08(w);
    const col = (await getLicense(w.db, SLUG, w.licenseId))!.overrides_json;
    expect(
      JSON.parse(
        mergeProvisionedOverrides(col, provisioned, {
          entitlements: new Set(["polarisVpn"]),
          secrets: new Set(),
        }),
      ).entitlements,
    ).toEqual(provisioned.entitlements);
    expect(await document(w, now)).toEqual(lx08);
  });
});

// ── 3. the catch-up ──────────────────────────────────────────────────────────────────────────

describe("the licensing catch-up (deploy hook and nightly)", () => {
  it("converges what a pre-LX-08 Worker wrote in the deploy window, and then writes nothing", async () => {
    const w = await world();
    await preLx08(w);
    await w.db.run(
      `INSERT INTO license_store_grants
         (product, license_id, flag, store, purchase_key_hash, state, granted_at, revoked_at)
       VALUES (?, ?, 'dlc.x', 'steam', 'hx', 'active', ?, NULL)`,
      SLUG,
      w.licenseId,
      NOW,
    );
    expect(await storeGrantDrift(w.db, SLUG)).not.toEqual([]);
    const r = await runLicensingCatchUp(w.db, SERVICES, NOW + 5);
    expect(r.failures).toEqual({});
    expect(r.provisioned.moved).toBe(1);
    expect(await storeGrantDrift(w.db, SLUG)).toEqual([]);
    const settled = await dump(w.db);
    const again = await runLicensingCatchUp(w.db, SERVICES, NOW + 6);
    expect(again.provisioned.moved).toBe(0);
    expect(await dump(w.db)).toBe(settled);
  });
});

// ── 4. tiers: rank at sign-in ────────────────────────────────────────────────────────────────

describe("tier rank at sign-in (S-19 §7.5)", () => {
  const tierOf = async (db: Db, id: string) =>
    (await getLicense(db, SLUG, id))!.tier_id;

  it("the highest-rank mapped tier wins; a tie keeps the first group", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), [SLUG]);
    await seedProduct(db, SLUG);
    await seedOidc(db);
    const product = (await loadProduct(env, db, SLUG))!;
    const tie = await activateFromIdentity(
      db,
      product,
      identity({ sub: "tie", groups: ["members", "vip"] }),
      NOW,
    );
    if (!("licenseId" in tie)) throw new Error("expected a licence");
    expect(await tierOf(db, tie.licenseId)).toBe("pro");
    await db.run(
      "UPDATE tiers SET rank = 2 WHERE product = ? AND id = 'gold'",
      SLUG,
    );
    const ranked = await activateFromIdentity(
      db,
      product,
      identity({ sub: "ranked", groups: ["members", "vip"] }),
      NOW,
    );
    if (!("licenseId" in ranked)) throw new Error("expected a licence");
    expect(await tierOf(db, ranked.licenseId)).toBe("gold");
  });

  it("syncTierOnSignIn: off leaves the tier; upgradeOnly moves up only, never the expiry", async () => {
    const w = await world();
    await w.db.run(
      "UPDATE tiers SET rank = 1 WHERE product = ? AND id = 'gold'",
      SLUG,
    );
    await w.db.run(
      "UPDATE licenses SET expires_at = ? WHERE product = ? AND id = ?",
      NOW + 1000,
      SLUG,
      w.licenseId,
    );
    const vip = identity({ groups: ["vip"] });
    await activateFromIdentity(w.db, w.product, vip, NOW + 10);
    expect(await tierOf(w.db, w.licenseId)).toBe("pro");

    await w.db.run(
      `INSERT INTO product_settings (product, key, value_json, source, updated_at, updated_by)
       VALUES (?, 'identity.oidc.syncTierOnSignIn', '"upgradeOnly"', 'console', ?, 'op')`,
      SLUG,
      NOW,
    );
    await activateFromIdentity(w.db, w.product, vip, NOW + 20);
    const lic = (await getLicense(w.db, SLUG, w.licenseId))!;
    expect(lic.tier_id).toBe("gold");
    expect(lic.expires_at).toBe(NOW + 1000);
    expect(
      await w.db.first(
        "SELECT action FROM audit WHERE product = ? AND target_id = ? AND action = 'license.tier.change'",
        SLUG,
        w.licenseId,
      ),
    ).toEqual({ action: "license.tier.change" });

    // Never down: back in `members` (rank 0) the licence stays on gold.
    await activateFromIdentity(w.db, w.product, identity(), NOW + 30);
    expect(await tierOf(w.db, w.licenseId)).toBe("gold");
  });
});

// ── 5. deletion, erasure, merge ──────────────────────────────────────────────────────────────

describe("the new rows go with what they belong to", () => {
  it("a deleted licence takes its oidc grant, its keys and its events", async () => {
    const w = await world();
    await w.db.run(
      `INSERT INTO entitlement_events (product, id, subject, license_id, keys_json, created_at)
       VALUES (?, 'ev1', NULL, ?, '["polarisVpn"]', ?)`,
      SLUG,
      w.licenseId,
      NOW,
    );
    const collector = licenseDeleteFor(SERVICES);
    await w.db.batch(
      collector.statements({ product: SLUG, licenseId: w.licenseId, now: NOW }),
    );
    for (const t of ["grants", "entitlement_events"])
      expect(
        await w.db.first(
          `SELECT COUNT(*) AS n FROM ${t} WHERE license_id = ?`,
          w.licenseId,
        ),
      ).toEqual({ n: 0 });
    expect(
      await w.db.first(
        "SELECT COUNT(*) AS n FROM grant_entitlements WHERE grant_id = ?",
        `grt_oidc_${w.licenseId}`,
      ),
    ).toEqual({ n: 0 });
  });

  it("a deleted product loses its account- and store-held grants and its subjects' events", async () => {
    const w = await world();
    const stmts = oidcGrantStatements({
      product: SLUG,
      licenseId: "unused",
      entries: {},
      declared: [],
      now: NOW,
      writer: "oidc",
      guard: null,
    });
    expect(stmts).toEqual([]);
    await w.db.run(
      `INSERT INTO grants (product, id, account_id, source, state, granted_at, created_by,
         modified_at, modified_by)
       VALUES (?, 'grt_comp_1', 'acct_1', 'comp', 'active', ?, 'op', ?, 'op')`,
      SLUG,
      NOW,
      NOW,
    );
    await w.db.run(
      `INSERT INTO grant_entitlements (product, grant_id, key, updated_at) VALUES (?, 'grt_comp_1', 'x', ?)`,
      SLUG,
      NOW,
    );
    await w.db.run(
      `INSERT INTO device_store_identities (product, device_id, store, store_identity_hash, verified_at)
       VALUES (?, 'dev-1', 'steam', 'sh', ?)`,
      SLUG,
      NOW,
    );
    await deleteProduct(w.db, SLUG, NOW);
    for (const [t, where] of [
      ["grants", "account_id IS NOT NULL"],
      ["grant_entitlements", "grant_id = 'grt_comp_1'"],
      ["device_store_identities", "1"],
    ])
      expect(
        await w.db.first(`SELECT COUNT(*) AS n FROM ${t} WHERE ${where}`),
      ).toEqual({ n: 0 });
    // The licence-held grant stays with its (disabled) licence.
    expect(await grantKeys(w)).toEqual(["polarisVpn"]);
  });

  it("entitlement events are a registered subject store: merged and deleted with the subject", async () => {
    expect(
      subjectStores().some(([, store]) => store === entitlementEventStore),
    ).toBe(true);
    const db = makeTestDb();
    await seedProduct(db, SLUG);
    for (const [id, subject] of [
      ["e1", "ps_a"],
      ["e2", "ps_b"],
    ])
      await db.run(
        `INSERT INTO entitlement_events (product, id, subject, keys_json, created_at)
         VALUES (?, ?, ?, '["k"]', ?)`,
        SLUG,
        id,
        subject,
        NOW,
      );
    const ctx = { db, env: makeEnv(new KvMock(), [SLUG]), now: NOW };
    await entitlementEventStore.merge(ctx, {
      product: SLUG,
      from: "ps_a",
      to: "ps_b",
    });
    expect(
      await entitlementEventStore.export!(ctx, {
        product: SLUG,
        subject: "ps_b",
      }),
    ).toEqual([
      { id: "e1", keys: ["k"], createdAt: NOW },
      { id: "e2", keys: ["k"], createdAt: NOW },
    ]);
    await entitlementEventStore.delete(ctx, { product: SLUG, subject: "ps_b" });
    expect(
      await db.first("SELECT COUNT(*) AS n FROM entitlement_events"),
    ).toEqual({ n: 0 });
  });
});
