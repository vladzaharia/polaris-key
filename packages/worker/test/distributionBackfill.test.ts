/**
 * P2b-01 — `0033_distribution_backfill.sql`: every product with Release on gets
 * `"distribution":{"enabled":true}` in `services_json`, whoever owns the row, and nothing else
 * changes.
 *
 * The database is built up to (not including) 0033, seeded with the shapes the previous build
 * wrote, then migrated — the 0027 suite's pattern (`releaseModel.test.ts`).
 */

import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SqliteDb } from "../src/db/sqlite.js";
import { parseServices, validateServices } from "../src/core/services.js";
import { setServices } from "../src/repo.js";
import { NOW, seedProduct } from "./seed.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, "..", "migrations");
const FILES = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const BACKFILL = "0033_distribution_backfill.sql";
const BEFORE = FILES.filter((f) => f < BACKFILL);
const AFTER = FILES.filter((f) => f > BACKFILL);

function sql(file: string): string {
  return readFileSync(join(MIGRATIONS_DIR, file), "utf8");
}

function databaseAt(files: string[]): { raw: Database.Database; db: SqliteDb } {
  const raw = new Database(":memory:");
  const run = raw.exec.bind(raw);
  for (const f of files) run(sql(f));
  return { raw, db: new SqliteDb(raw) };
}

function apply(raw: Database.Database, files: string[]): void {
  const run = raw.exec.bind(raw);
  for (const f of files) run(sql(f));
}

/** The five-slug blob the previous build wrote. */
function legacy(
  on: Partial<
    Record<"license" | "config" | "release" | "update" | "identity", boolean>
  >,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    license: { enabled: on.license ?? true },
    config: { enabled: on.config ?? true },
    release: { enabled: on.release ?? false },
    update: { enabled: on.update ?? false },
    identity: { enabled: on.identity ?? false },
    ...extra,
  });
}

interface Seed {
  slug: string;
  json: string | null;
  source: "manifest" | "admin";
}

const SEEDS: Seed[] = [
  // Release + Update on, manifest-owned (djdl's shape): gains distribution.
  {
    slug: "feed-manifest",
    json: legacy({ release: true, update: true }),
    source: "manifest",
  },
  // Release + Update on, admin-owned: gains it too — "whatever services_source says".
  {
    slug: "feed-admin",
    json: legacy({ release: true, update: true }),
    source: "admin",
  },
  // Release alone (a changelog / truth store): gains it, so downloads keep working after P2b-04.
  { slug: "truth-only", json: legacy({ release: true }), source: "manifest" },
  // Release off, manifest- and admin-owned: untouched.
  { slug: "licence-only", json: legacy({}), source: "manifest" },
  {
    slug: "identity-admin",
    json: legacy({ license: false, identity: true }),
    source: "admin",
  },
  // Never declared (NULL): untouched; it reads as the defaults, which have Release off.
  { slug: "defaults", json: null, source: "manifest" },
  // Release on, with a declared registration policy and an unknown slug: both survive.
  {
    slug: "extras",
    json: legacy(
      { release: true, update: true },
      { zeta: { enabled: true }, registration: "open" },
    ),
    source: "manifest",
  },
  // Already says something about distribution (a deliberate `false`): left alone.
  {
    slug: "chose-off",
    json: legacy({ release: true }, { distribution: { enabled: false } }),
    source: "admin",
  },
  // Release "on" as a string, not a JSON boolean: not Release on, not touched.
  {
    slug: "stringly",
    json: '{"release":{"enabled":"true"}}',
    source: "manifest",
  },
  // Unreadable blob: left exactly as it was (it keeps reading as the defaults).
  { slug: "garbage", json: "{not json", source: "manifest" },
  // Valid JSON, not an object.
  { slug: "array", json: "[1,2,3]", source: "manifest" },
];

async function seeded(): Promise<{ raw: Database.Database; db: SqliteDb }> {
  const { raw, db } = databaseAt(BEFORE);
  for (const s of SEEDS) {
    await seedProduct(db, s.slug);
    await setServices(db, s.slug, s.json, s.source, NOW);
  }
  return { raw, db };
}

async function rows(
  db: SqliteDb,
): Promise<Record<string, { json: string | null; source: string | null }>> {
  const all = await db.all<{
    slug: string;
    services_json: string | null;
    services_source: string | null;
  }>("SELECT slug, services_json, services_source FROM products ORDER BY slug");
  return Object.fromEntries(
    all.map((r) => [
      r.slug,
      { json: r.services_json, source: r.services_source },
    ]),
  );
}

describe("0033_distribution_backfill", () => {
  it("is numbered after every migration it depends on and is the only 0033", () => {
    expect(FILES.filter((f) => f.startsWith("0033"))).toEqual([BACKFILL]);
    expect(BEFORE.some((f) => f.startsWith("0020_services_source"))).toBe(true);
  });

  it("turns distribution on exactly where Release is on, whoever owns the row", async () => {
    const { raw, db } = await seeded();
    const before = await rows(db);
    apply(raw, [BACKFILL, ...AFTER]);
    const after = await rows(db);

    const gained = ["feed-manifest", "feed-admin", "truth-only", "extras"];
    for (const slug of Object.keys(before)) {
      // Ownership never moves.
      expect(after[slug]!.source, slug).toBe(before[slug]!.source);
      if (gained.includes(slug)) {
        const parsed = parseServices(after[slug]!.json);
        expect(parsed.services.distribution, slug).toEqual({ enabled: true });
        // Every other key is exactly what it was.
        const was = JSON.parse(before[slug]!.json!) as Record<string, unknown>;
        const now = JSON.parse(after[slug]!.json!) as Record<string, unknown>;
        expect(now, slug).toEqual({ ...was, distribution: { enabled: true } });
      } else {
        expect(after[slug]!.json, slug).toBe(before[slug]!.json);
      }
    }
  });

  it("leaves every product coherent under the new chain", async () => {
    // djdl's stored shape (release + update) would otherwise read as update_requires_distribution.
    const { raw, db } = await seeded();
    apply(raw, [BACKFILL, ...AFTER]);
    for (const slug of [
      "feed-manifest",
      "feed-admin",
      "truth-only",
      "extras",
    ]) {
      const { json } = (await rows(db))[slug]!;
      const parsed = parseServices(json);
      expect(validateServices(parsed.services), slug).toEqual([]);
    }
  });

  it("keeps the declared registration and an unknown slug", async () => {
    const { raw, db } = await seeded();
    apply(raw, [BACKFILL]);
    const parsed = parseServices((await rows(db)).extras!.json);
    expect(parsed.registration).toBe("open");
    expect(parsed.unknown).toEqual({ zeta: { enabled: true } });
    expect(parsed.services.update.enabled).toBe(true);
  });

  it("stores the value as a JSON object, not a string", async () => {
    const { raw, db } = await seeded();
    apply(raw, [BACKFILL]);
    const json = (await rows(db))["truth-only"]!.json!;
    expect(json).toContain('"distribution":{"enabled":true}');
  });

  it("replays to the same end state", async () => {
    const { raw, db } = await seeded();
    apply(raw, [BACKFILL, ...AFTER]);
    const once = await rows(db);
    apply(raw, [BACKFILL]);
    expect(await rows(db)).toEqual(once);
  });
});
