/// <reference types="@cloudflare/workers-types" />
// ── The erasure ledger on miniflare's R2, D1 and KV (I-11) ───────────────────────────────────
//
// The Node lane (`test/erasureLedger.test.ts`, `test/accountErasure.test.ts`) runs the ledger
// against `test/r2Mock.ts` and better-sqlite3. This file runs it against the real bindings, which
// is what proves the parts the fakes could get wrong: that R2 itself makes `If-None-Match: *` a
// create-only write of the JSON record (a second one answers `null`, the first body stands), that
// `list` pages the `erasures/` prefix by cursor and resumes by `startAfter`, that D1 accepts the
// `json_each` statements the replay is built on, and that the write-ahead erasure and the replay
// of a restored account hold up on the real D1 batch.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { D1Db } from "../src/db/d1.js";
import type { Env as WorkerEnv } from "../src/platform/env.js";
import {
  deleteAccount,
  replayErasures,
} from "../src/services/identity/accounts/deletion.js";
import {
  ERASURE_PREFIX,
  erasureKey,
  recordErasure,
  replayErasureLedger,
} from "../src/services/identity/accounts/erasureLedger.js";
import { NOW } from "./seed.js";

const LANE = { timeout: 60_000 };

function lane(): { e: WorkerEnv; db: D1Db; bucket: R2Bucket } {
  if (!env.BLOBS) throw new Error("BLOBS is not bound in the workerd lane");
  return {
    e: env as unknown as WorkerEnv,
    db: new D1Db(env.DB),
    bucket: env.BLOBS,
  };
}

const acct = (n: number) => `acct_wd_${String(n).padStart(3, "0")}`;
const accounts = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => acct(from + i));

async function seedAccount(db: D1Db, id: string): Promise<void> {
  await db.run(
    "INSERT INTO accounts (id, status, created_at, modified_at) VALUES (?, 'active', ?, ?)",
    id,
    NOW,
    NOW,
  );
}

const erasureTombstones = async (db: D1Db) =>
  (
    await db.all<{ id: string }>(
      "SELECT id FROM account_tombstones WHERE merged_into IS NULL ORDER BY id",
    )
  ).map((r) => r.id);

/** Every file of this lane shares one storage: start each test from an empty ledger. */
beforeEach(async () => {
  const { bucket, db } = lane();
  const listed = await bucket.list({ prefix: ERASURE_PREFIX });
  if (listed.objects.length > 0)
    await bucket.delete(listed.objects.map((o) => o.key));
  const marks = await env.HOT.list({ prefix: "p:_platform:erasure-ledger" });
  for (const k of marks.keys) await env.HOT.delete(k.name);
  await db.run("DELETE FROM account_tombstones");
  await db.run("DELETE FROM accounts");
});

describe("recordErasure on R2", LANE, () => {
  it("is create-only on the real binding: the second write answers exists and the first body stands", async () => {
    const { e, bucket } = lane();
    expect(await recordErasure(e, acct(1), 100)).toBe("created");
    const first = await bucket.head(erasureKey(acct(1)));
    expect(await recordErasure(e, acct(1), 200)).toBe("exists");
    expect((await bucket.head(erasureKey(acct(1))))?.etag).toBe(first?.etag);
    const stored = await bucket.get(erasureKey(acct(1)));
    expect(await stored!.text()).toBe(
      `{"v":1,"accountId":"${acct(1)}","erasedAt":100}`,
    );
    expect(stored!.httpMetadata?.contentType).toBe("application/json");
    expect(
      (await bucket.list({ prefix: ERASURE_PREFIX })).objects,
    ).toHaveLength(1);
  });
});

describe("replayErasureLedger on R2, D1 and KV", LANE, () => {
  it("pages the ledger by cursor, stops at its bound and resumes by startAfter", async () => {
    const { e, db } = lane();
    for (const id of accounts(1, 7)) await recordErasure(e, id, NOW);
    const erase = async () => ({ ok: true });
    const bounds = { pageSize: 3, maxPages: 1 };
    const marks = async () =>
      (await env.HOT.list({ prefix: "p:_platform:erasure-ledger" })).keys
        .length;

    // Real R2 truncates after three keys and names the cursor and the last key.
    expect(
      await replayErasureLedger({ db, env: e }, erase, bounds),
    ).toMatchObject({ scanned: 3, tombstoned: 3, more: true });
    expect(await marks()).toBe(1);
    expect(
      await replayErasureLedger({ db, env: e }, erase, bounds),
    ).toMatchObject({ scanned: 3, tombstoned: 3, more: true });
    // The last page is short: R2 answers truncated = false and the cycle is complete.
    expect(
      await replayErasureLedger({ db, env: e }, erase, bounds),
    ).toMatchObject({ scanned: 1, tombstoned: 1, more: false });
    expect(await marks()).toBe(0);
    expect(await erasureTombstones(db)).toEqual(accounts(1, 7));

    // Within one pass the cursor walks every page, with R2's own page size.
    expect(
      await replayErasureLedger({ db, env: e }, erase, { pageSize: 2 }),
    ).toMatchObject({ scanned: 7, tombstoned: 0, more: false });
  });

  it("re-erases a live account and copies a tombstone the ledger lacks, on the real D1", async () => {
    const { e, db, bucket } = lane();
    await seedAccount(db, acct(1));
    await recordErasure(e, acct(1), NOW);
    await db.run(
      "INSERT INTO account_tombstones (id, email_hash, merged_into, deleted_at) VALUES (?, NULL, NULL, 42)",
      acct(2),
    );
    const calls: string[] = [];
    const r = await replayErasureLedger({ db, env: e }, async (accountId) => {
      calls.push(accountId);
      await db.run("DELETE FROM accounts WHERE id = ?", accountId);
      return { ok: true };
    });
    expect(r).toEqual({
      scanned: 1,
      tombstoned: 1,
      reapplied: 1,
      deferred: 0,
      mirrored: 1,
      more: false,
      failures: [],
    });
    expect(calls).toEqual([acct(1)]);
    expect(await erasureTombstones(db)).toEqual([acct(1), acct(2)]);
    const copied = await bucket.get(erasureKey(acct(2)));
    expect(JSON.parse(await copied!.text())).toEqual({
      v: 1,
      accountId: acct(2),
      erasedAt: 42,
    });
  });
});

describe(
  "the write-ahead erasure and its replay on the real D1 batch",
  LANE,
  () => {
    it("records the id first, erases, and erases again an account a restore brought back", async () => {
      const { e, db, bucket } = lane();
      const id = acct(9);
      await seedAccount(db, id);
      const ctx = { db, env: e, now: NOW, origin: "https://key.plrs.im" };

      expect(await deleteAccount(ctx, id)).toEqual({ ok: true });
      expect(await (await bucket.get(erasureKey(id)))!.text()).toBe(
        `{"v":1,"accountId":"${id}","erasedAt":${NOW}}`,
      );
      expect(
        await db.first("SELECT id FROM accounts WHERE id = ?", id),
      ).toBeNull();
      expect(await erasureTombstones(db)).toEqual([id]);

      // What a Time Travel restore to before the erasure does to D1: the account is back and the
      // tombstone is gone. R2 keeps the record.
      await db.run("DELETE FROM account_tombstones WHERE id = ?", id);
      await seedAccount(db, id);
      expect(await replayErasures(ctx)).toMatchObject({
        scanned: 1,
        tombstoned: 1,
        reapplied: 1,
        failures: [],
      });
      expect(
        await db.first("SELECT id FROM accounts WHERE id = ?", id),
      ).toBeNull();
      expect(await erasureTombstones(db)).toEqual([id]);
      // Nothing is left to repair.
      expect(await replayErasures(ctx)).toMatchObject({
        tombstoned: 0,
        reapplied: 0,
        mirrored: 0,
      });
    });
  },
);
