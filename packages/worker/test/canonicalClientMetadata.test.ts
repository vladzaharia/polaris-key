/**
 * P1b-04 — `0040_canonical_client_metadata.sql`: every stored platform, arch and SDK name
 * converges on what the Worker's normaliser stores today (WIRE-CONTRACT-V3 §5.2 rule 3), every
 * stored empty value becomes NULL, and replaying the migration changes nothing.
 *
 * SP-08 — `0088_apple_platform_values.sql` extends the convergence to the spellings that gained a
 * canonical value later (`tvOS`, `visionOS`, `watchOS`). "Today" is therefore the two migrations
 * applied in order (`CONVERGENCE`): 0040 alone leaves those spellings as sent, as it did when it
 * shipped.
 *
 * The database is built up to (not including) the migration, seeded with one row per spelling,
 * then migrated — the `distributionBackfill.test.ts` pattern. The spellings are a LITERAL list,
 * not read from headers.json, so a spelling added to the corpus later cannot fail this migration.
 */

import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  normalizeArchHeader,
  normalizePlatformHeader,
  normalizeSdkHeader,
} from "../src/core/clientMetadata.js";
import { SqliteDb } from "../src/db/sqlite.js";
import { seedProduct } from "./seed.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, "..", "migrations");
const FILES = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const MIGRATION = "0040_canonical_client_metadata.sql";
const APPLE_MIGRATION = "0088_apple_platform_values.sql";
const BEFORE = FILES.filter((f) => f < MIGRATION);
/** The platform convergence migrations, in order. */
const CONVERGENCE = [MIGRATION, APPLE_MIGRATION];

const sql = (file: string): string =>
  readFileSync(join(MIGRATIONS_DIR, file), "utf8");

/** headers.json's platform spellings as of this migration. */
const PLATFORMS = [
  "macos",
  "macOS",
  "darwin",
  "Darwin",
  "macCatalyst",
  "ios",
  "iOS",
  "iPadOS",
  "android",
  "Android",
  "windows",
  "Windows",
  "win32",
  "linux",
  "Linux",
  "LINUX",
  "web",
  "Web",
  "browser",
  "FreeBSD",
  "freebsd",
  "sunos",
  "cygwin",
  "Emscripten",
  "visionOS",
  "tvOS",
  "unknown",
  "watchOS",
  "tvos",
  "visionos",
  "watchos",
  "WATCHOS",
  "",
  " linux",
  "constructor",
  "__proto__",
];
/** headers.json's arch spellings as of this migration. */
const ARCHS = [
  "x86_64",
  "X86_64",
  "x64",
  "amd64",
  "AMD64",
  "arm64",
  "ARM64",
  "aarch64",
  "arm64-v8a",
  "armv7",
  "armv7l",
  "armv8l",
  "arm",
  "arm32",
  "armeabi-v7a",
  "wasm32",
  "ia32",
  "x86",
  "i686",
  "x86_32",
  "armv6l",
  "riscv64",
  "wasm64",
  "arm64_32",
  "universal",
  "any",
  "unknown",
  "",
  "x86_64 ",
  "constructor",
  "__proto__",
];
/** The five pre-§5.2 SDK names, the five ids, an unknown name and the empty value. */
const SDKS = [
  "@polaris-key/node",
  "@polaris-key/react",
  "polaris-key-python",
  "PolarisKeySwift",
  "polaris-key-godot",
  "node",
  "react",
  "python",
  "swift",
  "godot",
  "polaris-node",
  "",
];

interface Row {
  device_id: string;
  platform: string | null;
  arch: string | null;
  sdk_name: string | null;
}

async function seeded(): Promise<Database.Database> {
  const raw = new Database(":memory:");
  for (const f of BEFORE) raw.exec(sql(f));
  await seedProduct(new SqliteDb(raw), "djdl");
  const insert = raw.prepare(
    "INSERT INTO devices (product, device_id, license_id, first_seen, last_seen, platform, arch, sdk_name) VALUES ('djdl', ?, 'lic', 1, 1, ?, ?, ?)",
  );
  const n = Math.max(PLATFORMS.length, ARCHS.length, SDKS.length);
  for (let i = 0; i < n; i++)
    insert.run(
      `dev_${i}`,
      PLATFORMS[i] ?? null,
      ARCHS[i] ?? null,
      SDKS[i] ?? null,
    );
  return raw;
}

const rows = (raw: Database.Database): Row[] =>
  raw
    .prepare(
      "SELECT device_id, platform, arch, sdk_name FROM devices ORDER BY CAST(substr(device_id, 5) AS INTEGER)",
    )
    .all() as Row[];

describe(MIGRATION, () => {
  it("is the next migration and holds no schema change", () => {
    expect(FILES).toContain(MIGRATION);
    expect(sql(MIGRATION)).not.toMatch(/\b(CREATE|ALTER|DROP)\b/i);
  });

  it("converges every stored value on the normaliser's output, and empty values on NULL", async () => {
    const raw = await seeded();
    for (const f of CONVERGENCE) raw.exec(sql(f));
    const got = rows(raw);
    got.forEach((row, i) => {
      const p = PLATFORMS[i];
      const a = ARCHS[i];
      const s = SDKS[i];
      expect(row.platform, `platform ${JSON.stringify(p)}`).toBe(
        p === undefined ? null : normalizePlatformHeader(p),
      );
      expect(row.arch, `arch ${JSON.stringify(a)}`).toBe(
        a === undefined ? null : normalizeArchHeader(a),
      );
      expect(row.sdk_name, `sdk ${JSON.stringify(s)}`).toBe(
        s === undefined ? null : normalizeSdkHeader(s),
      );
    });
    expect(got.some((r) => r.platform === "")).toBe(false);
    expect(got.some((r) => r.arch === "")).toBe(false);
    expect(got.some((r) => r.sdk_name === "")).toBe(false);
  });

  it("is idempotent: replaying it changes nothing", async () => {
    const raw = await seeded();
    raw.exec(sql(MIGRATION));
    const once = rows(raw);
    raw.exec(sql(MIGRATION));
    expect(rows(raw)).toEqual(once);
  });

  it("leaves the later Apple spellings as sent (0079 converges them)", async () => {
    const raw = await seeded();
    raw.exec(sql(MIGRATION));
    const got = rows(raw);
    for (const spelling of ["tvOS", "visionOS", "watchOS"])
      expect(got[PLATFORMS.indexOf(spelling)]!.platform).toBe(spelling);
  });
});

describe(APPLE_MIGRATION, () => {
  it("exists after 0040 and holds no schema change", () => {
    expect(FILES).toContain(APPLE_MIGRATION);
    expect(APPLE_MIGRATION > MIGRATION).toBe(true);
    expect(sql(APPLE_MIGRATION)).not.toMatch(/\b(CREATE|ALTER|DROP)\b/i);
  });

  it("converges tvOS, visionOS and watchOS spellings on their canonical values", async () => {
    const raw = await seeded();
    raw.exec(sql(MIGRATION));
    raw.exec(sql(APPLE_MIGRATION));
    const got = rows(raw);
    const want: Record<string, string> = {
      tvOS: "tvos",
      tvos: "tvos",
      visionOS: "visionos",
      visionos: "visionos",
      watchOS: "watchos",
      watchos: "watchos",
      WATCHOS: "watchos",
    };
    for (const [spelling, value] of Object.entries(want))
      expect(got[PLATFORMS.indexOf(spelling)]!.platform, spelling).toBe(value);
    // Nothing else moves.
    const unknown = got[PLATFORMS.indexOf("unknown")]!;
    expect(unknown.platform).toBe("unknown");
  });

  it("is idempotent: replaying it changes nothing", async () => {
    const raw = await seeded();
    for (const f of CONVERGENCE) raw.exec(sql(f));
    const once = rows(raw);
    raw.exec(sql(APPLE_MIGRATION));
    expect(rows(raw)).toEqual(once);
  });
});
