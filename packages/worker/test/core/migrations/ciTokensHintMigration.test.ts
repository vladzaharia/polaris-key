/**
 * F-33b.4's `ci_tokens_hint` migration (the number is the lead's to assign), rehearsed on a
 * scratch SQLite: every migration before it, a populated `ci_tokens` row, then the file and its
 * rollback. The file is the one bare `ADD COLUMN` statement the migration discipline allows
 * (R11-04), so a replay fails on it and strands nothing.
 */

import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TEST_ROOT } from "../../paths.js";

const ROOT = join(TEST_ROOT, "..");
const DIR = join(ROOT, "migrations");
const FILE = readdirSync(DIR).find((f) => /_ci_tokens_hint\.sql$/.test(f))!;
const DOWN = join(
  ROOT,
  "scripts",
  "rollback",
  FILE.replace(/\.sql$/, ".down.sql"),
);
const FILES = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const sql = (f: string) => readFileSync(join(DIR, f), "utf8");
const NOW = 1_700_000_000;

const columns = (raw: Database.Database): string[] =>
  (raw.prepare("PRAGMA table_info(ci_tokens)").all() as { name: string }[]).map(
    (c) => c.name,
  );

function before(): Database.Database {
  const raw = new Database(":memory:");
  for (const f of FILES) {
    if (f === FILE) break;
    raw.exec(sql(f));
  }
  raw
    .prepare(
      `INSERT INTO products (slug, name, signing_kid, signing_pub, compat_min, compat_max,
         default_max_offline_days, default_device_limit, created_at, modified_at)
       VALUES ('acme', 'acme', 'kid', 'pub', '0.0.0', '99.0.0', 30, 5, ?, ?)`,
    )
    .run(NOW, NOW);
  raw
    .prepare(
      `INSERT INTO ci_tokens (token_hash, token_id, product, kind, scopes_json, subject, label,
         jti, issued_at, expires_at, revoked_at, created_by)
       VALUES ('h', 'cit_1', 'acme', 'static', '["packages:read"]', 'static:cit_1', 'ci', NULL,
               ?, ?, NULL, 'u1')`,
    )
    .run(NOW, NOW + 3600);
  return raw;
}

describe("ci_tokens_hint migration", () => {
  it("adds hint, NULL on the rows that exist, and nothing else changes", () => {
    const raw = before();
    expect(columns(raw)).not.toContain("hint");
    raw.exec(sql(FILE));
    expect(raw.prepare("SELECT * FROM ci_tokens").all()).toEqual([
      expect.objectContaining({
        token_id: "cit_1",
        scopes_json: '["packages:read"]',
        hint: null,
      }),
    ]);
    raw.prepare("UPDATE ci_tokens SET hint = ?").run("ab12");
    expect(
      (
        raw.prepare("SELECT hint FROM ci_tokens").get() as {
          hint: string;
        }
      ).hint,
    ).toBe("ab12");
  });

  it("is one statement, so a replay fails on it and strands nothing", () => {
    const body = sql(FILE)
      .split("\n")
      .filter((l) => !l.startsWith("--") && l.trim() !== "")
      .join("\n");
    expect(body).toBe("ALTER TABLE ci_tokens ADD COLUMN hint TEXT;");
    const raw = before();
    raw.exec(sql(FILE));
    expect(() => raw.exec(sql(FILE))).toThrow(/duplicate column/i);
    expect(columns(raw).filter((c) => c === "hint")).toHaveLength(1);
  });

  it("the down script removes the column and keeps the rows", () => {
    const raw = before();
    raw.exec(sql(FILE));
    raw.exec(readFileSync(DOWN, "utf8"));
    expect(columns(raw)).not.toContain("hint");
    expect(raw.prepare("SELECT token_id FROM ci_tokens").all()).toEqual([
      { token_id: "cit_1" },
    ]);
  });
});
