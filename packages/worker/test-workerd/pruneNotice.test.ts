/// <reference types="@cloudflare/workers-types" />
// ── The feed-cleanup dry-run notice on D1 (F-36) ─────────────────────────────────────────────
//
// The Node lane (`test/surfaces/feedPrune.test.ts`) proves the rules against better-sqlite3. This runs the
// one batch `noticePruneRetention` writes against the real D1, which is what proves the part
// better-sqlite3 could get wrong: that inside a D1 batch the audit row's `changes()` guard reads
// the notice insert just before it, and that an insert that conflicts reports 0 changed rows. Of
// two callers that both found no notice, only the winner writes the notice's audit row and
// answers that it raised the notice; the loser answers the winner's.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { D1Db } from "../src/db/d1.js";
import type { Db } from "../src/db/types.js";
import {
  noticePruneRetention,
  PRUNE_NOTICE_SECONDS,
  type PruneNoticeOutcome,
} from "../src/services/release/packages/prune.js";
import { NOW, seedProduct } from "./seed.js";

const LANE = { timeout: 60_000 };
const SLUG = "notice-w";

describe("the dry-run notice on D1", LANE, () => {
  it("two callers that both found no notice write ONE notice and ONE audit row, and only the winner raised it", async () => {
    const db = new D1Db(env.DB);
    await seedProduct(env, db, SLUG, { schemaVersion: 1, entries: [] });
    const later = NOW + 3600;
    // The first caller's batch is held until a rival has committed: both read "no notice" first.
    const rival: { out: PruneNoticeOutcome | null } = { out: null };
    let held = true;
    const overtaken: Db = {
      all: (sql, ...p) => db.all(sql, ...p),
      first: (sql, ...p) => db.first(sql, ...p),
      run: (sql, ...p) => db.run(sql, ...p),
      runChanges: (sql, ...p) => db.runChanges(sql, ...p),
      batch: (stmts) => db.batch(stmts),
      batchChanges: async (stmts) => {
        if (held) {
          held = false;
          rival.out = await noticePruneRetention(db, env, SLUG, later);
        }
        return db.batchChanges(stmts);
      },
    };
    const loser = await noticePruneRetention(overtaken, env, SLUG, NOW);

    const inForce = {
      noticedAt: later,
      startsAt: later + PRUNE_NOTICE_SECONDS,
      packages: 0,
      versions: 0,
      bytes: 0,
      freedBytes: 0,
    };
    expect(held).toBe(false);
    expect(rival.out).toEqual({ notice: inForce, raised: true });
    expect(loser).toEqual({ notice: inForce, raised: false });
    expect(
      await db.all(
        "SELECT noticed_at, starts_at FROM release_package_retention_notices WHERE product = ?",
        SLUG,
      ),
    ).toEqual([{ noticed_at: later, starts_at: later + PRUNE_NOTICE_SECONDS }]);
    expect(
      await db.all(
        "SELECT at FROM audit WHERE product = ? AND action = 'package.prune.notice'",
        SLUG,
      ),
    ).toEqual([{ at: later }]);
    // Once raised, a later call has nothing to raise.
    expect(await noticePruneRetention(db, env, SLUG, later + 60)).toBeNull();
  });
});
