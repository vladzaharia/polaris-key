/**
 * One audit writer (P0-18) and its retention and export (ST-24).
 *
 * `core/audit.ts` builds every `audit` and `platform_audit` row. A grep over `src/` keeps it so;
 * the rest checks the builder, the retention that keeps each setting's latest row, and the
 * NDJSON export.
 */

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AUDIT_EXPORT_MAX_ROWS,
  SYSTEM_ACTORS,
  actorColumns,
  actorOf,
  appendAudit,
  appendPlatformAudit,
  auditStatement,
  exportAuditNdjson,
  exportPlatformAuditNdjson,
  platformAuditStatement,
  pruneAudit,
  prunePlatformAudit,
  sql,
} from "../src/core/audit.js";
import { makeTestDb } from "./helpers.js";
import { seedProduct } from "./seed.js";
import { SRC, stripComments, walkTs } from "./srcScan.js";

async function dbWith() {
  const db = await makeTestDb();
  await seedProduct(db, "acme");
  await seedProduct(db, "other");
  return db;
}

describe("one audit writer", () => {
  it("no file but core/audit.ts inserts into audit or platform_audit", () => {
    const INSERT =
      /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO)\s+(?:platform_)?audit\b/;
    const writers = walkTs(SRC)
      .filter((f) => INSERT.test(stripComments(readFileSync(f, "utf8"))))
      .map((f) => relative(SRC, f).split("\\").join("/"));
    // The builder composes `INTO ${table}`, so no literal insert exists anywhere.
    expect(writers).toEqual([]);
    expect(readFileSync(join(SRC, "core", "audit.ts"), "utf8")).toContain(
      "INTO ${table} (",
    );
  });

  it("actorOf reads the verified session; the system actors are named", () => {
    expect(actorOf({ sub: "s1", name: "Ann", email: "a@x.test" })).toEqual({
      sub: "s1",
      name: "Ann",
      email: "a@x.test",
    });
    expect(actorColumns(SYSTEM_ACTORS.resync)).toEqual({
      actor_sub: "resync",
      actor_name: "Manifest resync",
      actor_email: null,
    });
    expect(SYSTEM_ACTORS.platform.sub).toBeNull();
  });
});

describe("auditStatement", () => {
  const base = { product: "acme", at: 100, action: "x.y", summary: "s" };

  it("writes one row with a generated id and null for what is not given", async () => {
    const db = await dbWith();
    const stmt = auditStatement({
      ...base,
      ...actorColumns(SYSTEM_ACTORS.deploy),
    });
    await db.batch([stmt]);
    const row = await db.first<Record<string, unknown>>("SELECT * FROM audit");
    expect(row).toMatchObject({
      product: "acme",
      at: 100,
      actor_sub: "deploy",
      action: "x.y",
      summary: "s",
      target_kind: null,
      setting_key: null,
    });
    expect(String(row!.id)).toMatch(/^aud_/);
  });

  it("a guard writes the row only while it holds", async () => {
    const db = await dbWith();
    await db.batch([
      auditStatement({ ...base, id: "no" }, sql("WHERE 1 = 0")),
      auditStatement({ ...base, id: "yes" }, sql("WHERE ? = ?", 1, 1)),
    ]);
    expect(
      (await db.all("SELECT id FROM audit")).map(
        (r) => (r as { id: string }).id,
      ),
    ).toEqual(["yes"]);
  });

  it("a column may be an expression over the rows a FROM tail selects", async () => {
    const db = await dbWith();
    await db.run(
      "INSERT INTO product_settings (product, key, value_json, source, version, updated_at, updated_by) VALUES ('acme', 'k1', '1', 'console', 1, 1, 'x'), ('acme', 'k2', '2', 'console', 1, 1, 'x')",
    );
    await db.batch([
      auditStatement(
        {
          ...base,
          id: sql("'aud_' || key"),
          target_id: sql("key"),
          summary: sql("key || ' = ' || value_json"),
        },
        sql("FROM product_settings WHERE product = ?", "acme"),
      ),
    ]);
    const rows = await db.all<{ id: string; summary: string }>(
      "SELECT id, summary FROM audit ORDER BY id",
    );
    expect(rows).toEqual([
      { id: "aud_k1", summary: "k1 = 1" },
      { id: "aud_k2", summary: "k2 = 2" },
    ]);
  });

  it("the platform twin writes platform_audit", async () => {
    const db = await dbWith();
    await db.batch([
      platformAuditStatement({
        at: 5,
        ...actorColumns(SYSTEM_ACTORS.platform),
        action: "p.a",
        target_kind: null,
        target_id: null,
        summary: "p",
        setting_key: "k",
      }),
    ]);
    expect(
      await db.first(
        "SELECT action, setting_key, actor_name FROM platform_audit",
      ),
    ).toEqual({ action: "p.a", setting_key: "k", actor_name: "Polaris Key" });
  });
});

describe("retention keeps the latest row of each setting (ST-24)", () => {
  async function seed() {
    const db = await dbWith();
    const row = (
      product: string,
      id: string,
      at: number,
      setting_key: string | null,
    ) =>
      appendAudit(db, {
        product,
        id,
        at,
        action: "setting.update",
        summary: id,
        setting_key,
      });
    // acme: k1 changed three times, k2 once, two plain rows; all older than the cutoff (100).
    await row("acme", "k1-a", 10, "k1");
    await row("acme", "k1-b", 20, "k1");
    await row("acme", "k1-c", 30, "k1");
    await row("acme", "k2-a", 15, "k2");
    await row("acme", "plain-1", 12, null);
    await row("acme", "plain-2", 25, null);
    // A newer row inside the window does not save an older one of another setting.
    await row("acme", "k2-new", 150, "k2");
    // Another product's rows are never touched.
    await row("other", "o-k1", 5, "k1");
    return db;
  }
  const ids = async (db: Awaited<ReturnType<typeof seed>>, product: string) =>
    (
      await db.all<{ id: string }>(
        "SELECT id FROM audit WHERE product = ? ORDER BY at, id",
        product,
      )
    ).map((r) => r.id);

  it("purges everything past the cutoff except each setting's latest row", async () => {
    const db = await seed();
    const removed = await pruneAudit(db, "acme", 100, 100);
    // k1-a, k1-b, k2-a, plain-1, plain-2 go; k1-c is k1's latest; k2-new is inside the window.
    expect(removed).toBe(5);
    expect(await ids(db, "acme")).toEqual(["k1-c", "k2-new"]);
    expect(await ids(db, "other")).toEqual(["o-k1"]);
  });

  it("the kept row survives every later purge and does not hold the drain open", async () => {
    const db = await seed();
    await pruneAudit(db, "acme", 100, 100);
    expect(await pruneAudit(db, "acme", 100, 100)).toBe(0);
    // Each setting's latest row stays however old it is: k1-c, and k2-new.
    expect(await pruneAudit(db, "acme", 1_000_000, 100)).toBe(0);
    expect(await ids(db, "acme")).toEqual(["k1-c", "k2-new"]);
  });

  it("drains in batches and still ends", async () => {
    const db = await seed();
    let total = 0;
    for (let i = 0; i < 10; i++) {
      const n = await pruneAudit(db, "acme", 100, 2);
      total += n;
      if (n < 2) break;
    }
    expect(total).toBe(5);
    expect(await ids(db, "acme")).toEqual(["k1-c", "k2-new"]);
  });

  it("the platform trail keeps the latest row of each setting too", async () => {
    const db = await dbWith();
    const row = (id: string, at: number, setting_key: string | null) =>
      appendPlatformAudit(db, {
        id,
        at,
        ...actorColumns(SYSTEM_ACTORS.platform),
        action: "platform.setting.set",
        target_kind: null,
        target_id: null,
        summary: id,
        before_json: null,
        after_json: null,
        setting_key,
      });
    await row("a", 1, "s1");
    await row("b", 2, "s1");
    await row("c", 3, null);
    await row("d", 4, "s2");
    expect(await prunePlatformAudit(db, 100, 100)).toBe(2);
    expect(
      (
        await db.all<{ id: string }>(
          "SELECT id FROM platform_audit ORDER BY id",
        )
      ).map((r) => r.id),
    ).toEqual(["b", "d"]);
  });
});

describe("NDJSON export (ST-24)", () => {
  it("is one JSON object per line, newest first, every column, under the filters", async () => {
    const db = await dbWith();
    for (let i = 1; i <= 3; i++)
      await appendAudit(db, {
        product: "acme",
        id: `a${i}`,
        at: i * 10,
        action: i === 2 ? "license.create" : "setting.update",
        summary: `row ${i}`,
        setting_key: i === 2 ? null : "k",
        before_json: '{"effective":1}',
      });
    await appendAudit(db, {
      product: "other",
      id: "o",
      at: 99,
      action: "x",
      summary: "o",
    });

    const all = await exportAuditNdjson(db, "acme");
    expect(all.truncated).toBe(false);
    expect(all.rows).toBe(3);
    expect(all.body.endsWith("\n")).toBe(true);
    const lines = all.body
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.id)).toEqual(["a3", "a2", "a1"]);
    expect(lines[0]).toMatchObject({
      setting_key: "k",
      before_json: '{"effective":1}',
    });

    const some = await exportAuditNdjson(db, "acme", { action: "license." });
    expect(
      some.body
        .trimEnd()
        .split("\n")
        .map((l) => JSON.parse(l).id),
    ).toEqual(["a2"]);
    expect((await exportAuditNdjson(db, "nobody")).body).toBe("");
  });

  it("pages through the table and says when it stopped short", async () => {
    const db = await dbWith();
    const n = 450;
    await db.batch(
      Array.from({ length: n }, (_, i) =>
        auditStatement({
          product: "acme",
          id: `r${String(i).padStart(4, "0")}`,
          at: i,
          action: "a",
          summary: "s",
        }),
      ),
    );
    const out = await exportAuditNdjson(db, "acme");
    expect(out.rows).toBe(n);
    expect(out.truncated).toBe(false);
    expect(AUDIT_EXPORT_MAX_ROWS).toBeGreaterThan(n);
  });

  it("the platform trail exports too", async () => {
    const db = await dbWith();
    await appendPlatformAudit(db, {
      id: "p1",
      at: 1,
      ...actorColumns(SYSTEM_ACTORS.deploy),
      action: "platform.x",
      target_kind: null,
      target_id: null,
      summary: "s",
      before_json: null,
      after_json: null,
    });
    const out = await exportPlatformAuditNdjson(db);
    expect(JSON.parse(out.body.trim())).toMatchObject({
      id: "p1",
      action: "platform.x",
    });
  });
});
