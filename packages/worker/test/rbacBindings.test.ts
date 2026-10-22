/**
 * ST-31 slice 1: `console_role_bindings` (ST-28 plan §5.1) and Core's store for it.
 *
 * The table is inert here (nothing reads grants from it before slice 2); what is proved is the
 * DDL's constraints, its two migrations' replay and rollback, the store's fail-closed reading,
 * and G8 part 1: deleting a product deletes exactly its `product:<slug>` bindings.
 */
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import "../src/mount.js";
import { SqliteDb } from "../src/db/sqlite.js";
import { deleteProduct } from "../src/core/products/store.js";
import { AREA_IDS, PRODUCT_AREAS } from "../src/core/rbac/areas.js";
import {
  listAccountGrants,
  listPendingInvites,
  mergeAreas,
  newBindingId,
  normalizeAreas,
  rowToGrant,
  stmtDeleteBinding,
  stmtInsertBinding,
  type BindingRow,
  type NewBinding,
} from "../src/core/rbac/bindings.js";
import { makeTestDb } from "./helpers.js";
import { NOW, seedProduct } from "./seed.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "..", "migrations");
const FILES = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const A = "0129_a_console_role_bindings.sql";
const B = "0129_b_platform_audit_action_idx.sql";
const DOWN_A = readFileSync(
  join(
    HERE,
    "..",
    "scripts",
    "rollback",
    "0129_a_console_role_bindings.down.sql",
  ),
  "utf8",
);
const DOWN_B = readFileSync(
  join(
    HERE,
    "..",
    "scripts",
    "rollback",
    "0129_b_platform_audit_action_idx.down.sql",
  ),
  "utf8",
);
const sql = (f: string) => readFileSync(join(DIR, f), "utf8");

function insertAccount(db: Database.Database, id: string): void {
  db.prepare(
    "INSERT INTO accounts (id, created_at, modified_at) VALUES (?, ?, ?)",
  ).run(id, NOW, NOW);
}

/** Insert a raw row; later columns default to a valid account/`console_access` binding. */
function raw(db: Database.Database, o: Partial<Record<string, unknown>>) {
  const r = {
    id: newBindingId(),
    account_id: "acc_1",
    email_norm: null,
    role: "console_access",
    scope: "platform",
    areas_json: null,
    source: "grant",
    granted_by: null,
    granted_at: NOW,
    expires_at: null,
    ...o,
  };
  db.prepare(
    `INSERT INTO console_role_bindings
       (id, account_id, email_norm, role, scope, areas_json, source, granted_by, granted_at, expires_at)
     VALUES (@id, @account_id, @email_norm, @role, @scope, @areas_json, @source, @granted_by, @granted_at, @expires_at)`,
  ).run(r);
}

function fresh(): Database.Database {
  const db = new Database(":memory:");
  expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  for (const f of FILES) db.exec(sql(f));
  insertAccount(db, "acc_1");
  insertAccount(db, "acc_2");
  return db;
}

const count = (db: Database.Database) =>
  (
    db.prepare("SELECT COUNT(*) AS n FROM console_role_bindings").get() as {
      n: number;
    }
  ).n;

describe("migrations", () => {
  it("sort after 0128 and before the next number, a before b", () => {
    expect(FILES.indexOf(A)).toBeGreaterThan(-1);
    expect(FILES.indexOf(B)).toBe(FILES.indexOf(A) + 1);
  });

  it("replay twice leaves the schema and data unchanged", () => {
    const db = fresh();
    raw(db, {});
    const schema = () =>
      db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all();
    const before = schema();
    db.exec(sql(A));
    db.exec(sql(B));
    expect(schema()).toEqual(before);
    expect(count(db)).toBe(1);
  });

  it("down removes exactly what up made, and up works again after", () => {
    const db = fresh();
    const names = () =>
      (
        db.prepare("SELECT name FROM sqlite_master ORDER BY name").all() as {
          name: string;
        }[]
      ).map((r) => r.name);
    const withBoth = names();
    db.exec(DOWN_B);
    expect(names()).toEqual(
      withBoth.filter((n) => n !== "idx_platform_audit_action"),
    );
    db.exec(DOWN_A);
    expect(names()).toEqual(
      withBoth.filter(
        (n) =>
          ![
            "idx_platform_audit_action",
            "console_role_bindings",
            "idx_crb_account",
            "idx_crb_email",
            "idx_crb_scope",
            "sqlite_autoindex_console_role_bindings_1",
          ].includes(n),
      ),
    );
    db.exec(DOWN_A); // idempotent
    db.exec(DOWN_B);
    db.exec(sql(A));
    db.exec(sql(B));
    expect(names()).toEqual(withBoth);
  });

  it("the audit index covers (action, actor_sub, at DESC)", () => {
    const db = fresh();
    const cols = db
      .prepare("PRAGMA index_xinfo(idx_platform_audit_action)")
      .all() as { name: string | null; desc: number; key: number }[];
    const keys = cols.filter((c) => c.key === 1);
    expect(keys.map((c) => c.name)).toEqual(["action", "actor_sub", "at"]);
    expect(keys.map((c) => c.desc)).toEqual([0, 0, 1]);
  });
});

describe("constraints", () => {
  it("accepts a valid row of each kind", () => {
    const db = fresh();
    raw(db, { role: "superadmin" });
    raw(db, { role: "platform_admin", account_id: "acc_2" });
    raw(db, { role: "product_admin", scope: "products:*" });
    raw(db, {
      role: "product_admin",
      scope: "product:x",
      areas_json: '["core"]',
    });
    raw(db, {
      account_id: null,
      email_norm: "a@b.c",
      source: "invite",
      expires_at: NOW + 7 * 86400,
    });
    expect(count(db)).toBe(5);
  });

  const BAD: [string, Partial<Record<string, unknown>>][] = [
    ["both subjects", { email_norm: "a@b.c" }],
    ["neither subject", { account_id: null }],
    ["an unknown role", { role: "owner" }],
    ["scope 'product:'", { role: "product_admin", scope: "product:" }],
    ["an unknown scope", { scope: "everything" }],
    ["product_admin at platform", { role: "product_admin" }],
    ["console_access on a product", { scope: "product:x" }],
    ["superadmin on products:*", { role: "superadmin", scope: "products:*" }],
    [
      "areas_json on a non-product_admin",
      { role: "platform_admin", areas_json: '["core"]' },
    ],
    ["expires_at on an account row", { expires_at: NOW + 1 }],
  ];
  for (const [name, o] of BAD) {
    it(`refuses ${name}`, () => {
      const db = fresh();
      expect(() => raw(db, o)).toThrow(/CHECK constraint|constraint/i);
      expect(count(db)).toBe(0);
    });
  }

  it("refuses a duplicate account (role, scope) but allows another role or account", () => {
    const db = fresh();
    raw(db, {});
    expect(() => raw(db, {})).toThrow(/UNIQUE/);
    raw(db, { account_id: "acc_2" });
    raw(db, { role: "platform_admin" });
    expect(count(db)).toBe(3);
  });

  it("refuses a duplicate email (role, scope); an account and an email may share one", () => {
    const db = fresh();
    const inv = { account_id: null, email_norm: "a@b.c", source: "invite" };
    raw(db, inv);
    expect(() => raw(db, inv)).toThrow(/UNIQUE/);
    raw(db, {}); // the same (role, scope), held by an account
    raw(db, { ...inv, email_norm: "d@e.f" });
    expect(count(db)).toBe(3);
  });

  it("an account delete cascades to its rows only", () => {
    const db = fresh();
    raw(db, {});
    raw(db, { account_id: "acc_2" });
    raw(db, { account_id: null, email_norm: "a@b.c", source: "invite" });
    db.prepare("DELETE FROM accounts WHERE id = 'acc_1'").run();
    const left = db
      .prepare("SELECT account_id, email_norm FROM console_role_bindings")
      .all();
    expect(left).toEqual([
      { account_id: "acc_2", email_norm: null },
      { account_id: null, email_norm: "a@b.c" },
    ]);
  });

  it("refuses an account that does not exist", () => {
    const db = fresh();
    expect(() => raw(db, { account_id: "acc_nope" })).toThrow(/FOREIGN KEY/);
  });
});

describe("store", () => {
  it("newBindingId is crb_ plus 22 base64url characters, and distinct", () => {
    const ids = new Set(Array.from({ length: 50 }, newBindingId));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^crb_[A-Za-z0-9_-]{22}$/);
  });

  it("normalizeAreas dedupes, orders by AREAS, and rejects empty or non-product ids", () => {
    expect(normalizeAreas(["settings", "core", "core", "license"])).toEqual([
      "core",
      "license",
      "settings",
    ]);
    expect(normalizeAreas([...PRODUCT_AREAS].reverse())).toEqual([
      ...PRODUCT_AREAS,
    ]);
    expect(() => normalizeAreas([])).toThrow();
    expect(() => normalizeAreas(["platform"])).toThrow(); // platform-scope only
    expect(() => normalizeAreas(["console"])).toThrow();
    expect(() => normalizeAreas(["nope"])).toThrow();
  });

  it("mergeAreas unions in AREAS order and NULL wins", () => {
    expect(mergeAreas(null, null)).toBeNull();
    expect(mergeAreas(null, ["core"])).toBeNull();
    expect(mergeAreas(["core"], null)).toBeNull();
    expect(mergeAreas(["settings", "core"], ["license", "core"])).toEqual([
      "core",
      "license",
      "settings",
    ]);
    expect(mergeAreas([], ["core"])).toEqual(["core"]);
    expect(AREA_IDS).toContain("members");
    expect(mergeAreas(["members"], ["core"])).toEqual(["members", "core"]);
  });

  const row = (o: Partial<BindingRow>): BindingRow => ({
    id: "crb_x",
    account_id: "acc_1",
    email_norm: null,
    role: "product_admin",
    scope: "product:x",
    areas_json: null,
    source: "grant",
    granted_by: null,
    granted_at: NOW,
    expires_at: null,
    ...o,
  });

  it("rowToGrant reads a row and fails closed on anything unreadable", () => {
    expect(rowToGrant(row({ areas_json: '["settings","core"]' }))).toEqual({
      role: "product_admin",
      scope: "product:x",
      areas: ["core", "settings"],
      source: "grant",
    });
    expect(rowToGrant(row({}))?.areas).toBeNull();
    // The system product takes no product scope; a 65-character slug is over the slug cap.
    expect(rowToGrant(row({ scope: "product:polaris-key" }))).toBeNull();
    expect(rowToGrant(row({ scope: `product:${"a".repeat(65)}` }))).toBeNull();
    expect(rowToGrant(row({ areas_json: '["core","bogus"]' }))).toBeNull();
    expect(rowToGrant(row({ areas_json: "[]" }))).toBeNull();
    expect(rowToGrant(row({ areas_json: "{" }))).toBeNull();
    expect(rowToGrant(row({ areas_json: '"core"' }))).toBeNull();
    expect(rowToGrant(row({ role: "owner" }))).toBeNull();
    expect(rowToGrant(row({ scope: "everywhere" }))).toBeNull();
    expect(rowToGrant(row({ source: "root" }))).toBeNull();
  });

  const nb = (o: Partial<NewBinding>): NewBinding => ({
    id: newBindingId(),
    accountId: "acc_1",
    emailNorm: null,
    role: "console_access",
    scope: "platform",
    areas: null,
    source: "grant",
    grantedBy: "mbr_g",
    grantedAt: NOW,
    ...o,
  });

  it("listAccountGrants ignores email rows; an unknown area drops only that grant", async () => {
    const sqlite = new Database(":memory:");
    for (const f of FILES) sqlite.exec(sql(f));
    insertAccount(sqlite, "acc_1");
    const db = new SqliteDb(sqlite);
    await db.batch([
      stmtInsertBinding(nb({ role: "platform_admin" })),
      stmtInsertBinding(
        nb({
          role: "product_admin",
          scope: "product:x",
          areas: normalizeAreas(["settings", "core"]),
          source: "creator",
          // Distinct from the row before: the read orders by granted_at, then by random id.
          grantedAt: NOW + 1,
        }),
      ),
      stmtInsertBinding(
        nb({
          accountId: null,
          emailNorm: "a@b.c",
          role: "superadmin",
          source: "invite",
          expiresAt: NOW + 100,
        }),
      ),
    ]);
    // A row written by a newer Worker with an area this build does not know.
    sqlite
      .prepare(
        `INSERT INTO console_role_bindings (id, account_id, role, scope, areas_json, source, granted_at)
         VALUES ('crb_future', 'acc_1', 'product_admin', 'product:y', '["core","hologram"]', 'grant', ?)`,
      )
      .run(NOW);
    const grants = await listAccountGrants(db, "acc_1");
    expect(grants).toEqual([
      {
        role: "platform_admin",
        scope: "platform",
        areas: null,
        source: "grant",
      },
      {
        role: "product_admin",
        scope: "product:x",
        areas: ["core", "settings"],
        source: "creator",
      },
    ]);
    expect(await listAccountGrants(db, "acc_2")).toEqual([]);
  });

  it("listPendingInvites returns unexpired rows for the address only", async () => {
    const sqlite = new Database(":memory:");
    for (const f of FILES) sqlite.exec(sql(f));
    const db = new SqliteDb(sqlite);
    const inv = (o: Partial<NewBinding>) =>
      stmtInsertBinding(
        nb({ accountId: null, emailNorm: "a@b.c", source: "invite", ...o }),
      );
    await db.batch([
      inv({ expiresAt: NOW + 10 }),
      inv({ role: "platform_admin", expiresAt: NOW }), // expired exactly now
      inv({ role: "superadmin", expiresAt: NOW - 1 }),
      inv({ emailNorm: "other@b.c", expiresAt: NOW + 10 }),
    ]);
    const rows = await listPendingInvites(db, "a@b.c", NOW);
    expect(rows.map((r) => r.role)).toEqual(["console_access"]);
  });

  it("an invite with no expiry never counts as pending", async () => {
    const sqlite = new Database(":memory:");
    for (const f of FILES) sqlite.exec(sql(f));
    const db = new SqliteDb(sqlite);
    sqlite
      .prepare(
        `INSERT INTO console_role_bindings (id, email_norm, role, scope, source, granted_at)
         VALUES ('crb_noexp', 'a@b.c', 'console_access', 'platform', 'invite', ?)`,
      )
      .run(NOW);
    expect(await listPendingInvites(db, "a@b.c", NOW)).toEqual([]);
  });

  it("stmtInsertBinding refuses what the reader would drop", () => {
    expect(() =>
      stmtInsertBinding(nb({ role: "platform_admin", areas: ["core"] })),
    ).toThrow(/areas/);
    expect(() =>
      stmtInsertBinding(
        nb({ role: "product_admin", scope: "product:x", areas: [] }),
      ),
    ).toThrow(/empty/);
    expect(() =>
      stmtInsertBinding(
        nb({
          role: "product_admin",
          scope: "product:x",
          areas: ["platform" as never],
        }),
      ),
    ).toThrow(/product area/);
    expect(() =>
      stmtInsertBinding(
        nb({ accountId: null, emailNorm: "a@b.c", source: "invite" }),
      ),
    ).toThrow(/expiry/);
    for (const scope of [
      "product:X",
      "product:",
      "product:a b",
      "Platform",
      "products:x",
      "*",
    ])
      expect(() =>
        stmtInsertBinding(nb({ role: "product_admin", scope: scope as never })),
      ).toThrow(/scope/);
    expect(() =>
      stmtInsertBinding(nb({ role: "platform_admin", scope: "product:x" })),
    ).toThrow(/scope/);
    expect(() =>
      stmtInsertBinding(nb({ role: "product_admin", scope: "platform" })),
    ).toThrow(/scope/);
  });

  it("rowToGrant re-checks areas, role/scope agreement and scope spelling", () => {
    const row = (o: Partial<BindingRow>): BindingRow => ({
      id: "crb_x",
      account_id: "acc_1",
      email_norm: null,
      role: "product_admin",
      scope: "product:x",
      areas_json: null,
      source: "grant",
      granted_by: null,
      granted_at: NOW,
      expires_at: null,
      ...o,
    });
    expect(rowToGrant(row({}))).not.toBeNull();
    expect(rowToGrant(row({ areas_json: '["platform"]' }))).toBeNull();
    expect(rowToGrant(row({ areas_json: '["console"]' }))).toBeNull();
    expect(
      rowToGrant(
        row({
          role: "platform_admin",
          scope: "platform",
          areas_json: '["core"]',
        }),
      ),
    ).toBeNull();
    expect(
      rowToGrant(row({ role: "platform_admin", scope: "product:x" })),
    ).toBeNull();
    expect(
      rowToGrant(row({ role: "product_admin", scope: "platform" })),
    ).toBeNull();
    expect(rowToGrant(row({ scope: "product:X" }))).toBeNull();
    expect(rowToGrant(row({ scope: "product:a b" }))).toBeNull();
  });

  it("stmtDeleteBinding deletes one row", async () => {
    const sqlite = new Database(":memory:");
    for (const f of FILES) sqlite.exec(sql(f));
    insertAccount(sqlite, "acc_1");
    const db = new SqliteDb(sqlite);
    const a = nb({});
    const b = nb({ role: "platform_admin" });
    await db.batch([stmtInsertBinding(a), stmtInsertBinding(b)]);
    await db.batch([stmtDeleteBinding(a.id)]);
    expect(count(sqlite)).toBe(1);
  });
});

describe("deleteProduct (ST-28 G8, part 1)", () => {
  it("removes only product:<slug> rows", async () => {
    const db = makeTestDb();
    await db.run(
      "INSERT INTO accounts (id, created_at, modified_at) VALUES ('acc_1', ?, ?)",
      NOW,
      NOW,
    );
    await seedProduct(db, "gone");
    await seedProduct(db, "kept");
    const pa = (scope: string, o: Partial<NewBinding> = {}) =>
      stmtInsertBinding({
        id: newBindingId(),
        accountId: "acc_1",
        emailNorm: null,
        role: "product_admin",
        scope: scope as NewBinding["scope"],
        areas: null,
        source: "grant",
        grantedBy: null,
        grantedAt: NOW,
        ...o,
      });
    await db.batch([
      pa("product:gone"),
      pa("product:gone", {
        role: "product_admin",
        accountId: null,
        emailNorm: "i@j.k",
        source: "invite",
        expiresAt: NOW + 5,
      }),
      pa("product:kept"),
      pa("product:gone-too"), // a slug that merely starts with the deleted one
      pa("products:*"),
      pa("platform", { role: "platform_admin" }),
    ]);
    await deleteProduct(db, "gone", NOW + 1);
    const left = await db.all<{ scope: string }>(
      "SELECT scope FROM console_role_bindings ORDER BY scope",
    );
    expect(left.map((r) => r.scope)).toEqual([
      "platform",
      "product:gone-too",
      "product:kept",
      "products:*",
    ]);
  });
});
