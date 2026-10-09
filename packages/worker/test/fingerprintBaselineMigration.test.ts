// The baseline migration, replayed on a populated device_fingerprints table.
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const FILES = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const TARGET = FILES.find((f) => f.endsWith("_fingerprint_baseline.sql"))!;

describe("fingerprint baseline migration", () => {
  it("backfills only verified rows with the anchor and three or more components", () => {
    const db = new Database(":memory:");
    for (const f of FILES.filter((f) => f !== TARGET)) {
      // Only the migrations up to the table's last change matter, but all apply cleanly.
      if (f > TARGET) continue;
      db.exec(readFileSync(join(DIR, f), "utf8"));
    }
    db.pragma("foreign_keys = OFF");
    const ins = db.prepare(
      `INSERT INTO device_fingerprints (product, device_id, hwid, components_json, anchor_hash,
         status, first_seen, last_seen) VALUES ('p', ?, 'h', ?, ?, ?, 11, 22)`,
    );
    const three = JSON.stringify({
      machineUuid: "a",
      cpuModel: "b",
      ramBucket: "c",
    });
    ins.run("ok", three, "a", "verified");
    ins.run(
      "thin",
      JSON.stringify({ machineUuid: "a", cpuModel: "b" }),
      "a",
      "verified",
    );
    ins.run("noanchor", three, null, "verified");
    ins.run("unverified", "{}", null, "unverified");
    ins.run("junk", "not json", "a", "verified");

    db.exec(readFileSync(join(DIR, TARGET), "utf8"));

    const rows = Object.fromEntries(
      (
        db
          .prepare(
            "SELECT device_id, baseline_components_json b, baseline_anchor_hash a, baseline_at t FROM device_fingerprints",
          )
          .all() as {
          device_id: string;
          b: string | null;
          a: string | null;
          t: number | null;
        }[]
      ).map((r) => [r.device_id, r]),
    );
    expect(rows.ok).toEqual({ device_id: "ok", b: three, a: "a", t: 11 });
    for (const id of ["thin", "noanchor", "unverified", "junk"]) {
      expect(rows[id]).toMatchObject({ b: null, a: null, t: null });
    }
  });
});
