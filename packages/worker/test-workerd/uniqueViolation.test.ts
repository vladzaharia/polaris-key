/// <reference types="@cloudflare/workers-types" />
// ── D1's UNIQUE-constraint wording (PX-W9 review N3) ──────────────────────────────────────
//
// `claimDeviceSeat` (repo.ts) retries a seat claim ONLY when the failure reads "UNIQUE constraint
// failed" (another isolate took the ordinal first), and rethrows anything else; Discover's claim
// (portal/discover.ts) reads the same words. The Node lane runs better-sqlite3, so only this lane
// proves real D1 words the failure that way, for a single statement and inside a batch. If D1
// ever changed its wording, every ordinal race would surface as an error instead of a retry.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { D1Db } from "../src/db/d1.js";

const UNIQUE = /UNIQUE constraint failed/i;

describe("D1 words a UNIQUE violation as the seat claim expects", () => {
  it("in a single statement and inside a batch", async () => {
    const db = new D1Db(env.DB);
    await db.run(
      "CREATE TABLE IF NOT EXISTS pkey_unique_probe (k TEXT NOT NULL, n INTEGER NOT NULL, CHECK (n >= 0))",
    );
    await db.run(
      "CREATE UNIQUE INDEX IF NOT EXISTS pkey_unique_probe_k ON pkey_unique_probe (k)",
    );
    await db.run("INSERT INTO pkey_unique_probe (k, n) VALUES ('a', 1)");

    const single = await db
      .run("INSERT INTO pkey_unique_probe (k, n) VALUES ('a', 2)")
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(single).toBeInstanceOf(Error);
    expect((single as Error).message).toMatch(UNIQUE);

    const batched = await db
      .batch([
        {
          sql: "INSERT INTO pkey_unique_probe (k, n) VALUES ('b', 1)",
          params: [],
        },
        {
          sql: "INSERT INTO pkey_unique_probe (k, n) VALUES ('a', 3)",
          params: [],
        },
      ])
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(batched).toBeInstanceOf(Error);
    expect((batched as Error).message).toMatch(UNIQUE);
    // The batch rolled back as a whole.
    const b = await db.first<{ c: number }>(
      "SELECT count(*) AS c FROM pkey_unique_probe WHERE k = 'b'",
    );
    expect(b?.c).toBe(0);

    // Any other constraint is NOT worded as a UNIQUE violation, so it is rethrown, not retried.
    const check = await db
      .run("INSERT INTO pkey_unique_probe (k, n) VALUES ('c', -1)")
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(check).toBeInstanceOf(Error);
    expect((check as Error).message).not.toMatch(UNIQUE);
  });
});
