/**
 * I-11 (S-16 §5.5): the erasure ledger and its replay.
 *
 * The D1 tombstone cannot survive a Time Travel restore, so `deleteAccount` first records the id
 * in R2, create-only (`recordErasure`), and `replayErasureLedger` applies the ledger back to D1:
 * the tombstone of every listed id is recreated, an account that is live again is handed to the
 * erasure state machine, and an erasure tombstone the ledger lacks is copied into it. These tests
 * pin that module's contract with a fake erasure callback; `accountErasure.test.ts` runs the same
 * replay through the real state machine, a snapshot restore included, and `scheduled.test.ts`
 * through both cron ticks.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { asR2, R2Mock } from "./r2Mock.js";
import { makeEnv, NOW } from "./seed.js";
import type { Db } from "../src/db/types.js";
import { parseKey, putVerified } from "../src/core/assets/blobs.js";
import {
  TOMBSTONE_RETENTION_SECONDS,
  purgePrivacyResidue,
} from "../src/privacyResidue.js";
import {
  ERASURE_PREFIX,
  erasureKey,
} from "../src/core/accounts/erasureFence.js";
import {
  ERASURE_LEDGER_PAGE,
  ErasureLedgerError,
  recordErasure,
  replayErasureLedger,
  type ReplayBounds,
} from "../src/services/identity/accounts/erasureLedger.js";

const acct = (n: number) => `acct_${String(n).padStart(4, "0")}`;
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => acct(from + i));

/** Records every `list` call, to show the cursor walk. */
class ListSpy extends R2Mock {
  readonly lists: R2ListOptions[] = [];
  override async list(options?: R2ListOptions) {
    this.lists.push({ ...options });
    return super.list(options);
  }
}

function world(r2: R2Mock = new R2Mock(), kv: KvMock = new KvMock()) {
  const db = makeTestDb();
  const env = makeEnv(kv, []);
  env.BLOBS = asR2(r2);
  return { db, env, kv, r2 };
}

async function seedAccount(
  db: Db,
  id: string,
  status: "active" | "disabled" | "deleted" = "active",
): Promise<void> {
  await db.run(
    "INSERT INTO accounts (id, status, created_at, modified_at) VALUES (?, ?, ?, ?)",
    id,
    status,
    NOW,
    NOW,
  );
}

/** The erasure state machine, reduced to what the replay needs from it: the account is gone. */
function eraser(db: Db) {
  const calls: string[] = [];
  const erase = async (accountId: string) => {
    calls.push(accountId);
    await db.run("DELETE FROM accounts WHERE id = ?", accountId);
    return { ok: true };
  };
  return Object.assign(erase, { calls });
}

const column = async (db: Db, sql: string) =>
  (await db.all<{ id: string }>(sql)).map((r) => r.id);
const erasureTombstones = (db: Db) =>
  column(
    db,
    "SELECT id FROM account_tombstones WHERE merged_into IS NULL ORDER BY id",
  );
const ledgerIds = (r2: R2Mock) =>
  r2
    .keys()
    .filter((k) => k.startsWith(ERASURE_PREFIX))
    .map((k) => k.slice(ERASURE_PREFIX.length));
const bodyOf = async (r2: R2Mock, accountId: string) =>
  await ((await r2.get(erasureKey(accountId))) as R2ObjectBody).text();

describe("recordErasure: the write-ahead record", () => {
  it("is create-only: the first record stands, and a second answers exists and changes nothing", async () => {
    const { env, r2 } = world();
    expect(await recordErasure(env, "acct_a", 100)).toBe("created");
    const first = await r2.head("erasures/acct_a");
    expect(await recordErasure(env, "acct_a", 200)).toBe("exists");
    expect((await r2.head("erasures/acct_a"))?.etag).toBe(first?.etag);
    expect(await bodyOf(r2, "acct_a")).toBe(
      '{"v":1,"accountId":"acct_a","erasedAt":100}',
    );
    expect(r2.putAttempts).toEqual(["erasures/acct_a", "erasures/acct_a"]);
    expect(r2.keys()).toEqual(["erasures/acct_a"]);
  });

  it("holds the opaque id, the version and a time: three fields, no person", async () => {
    const { env, r2 } = world();
    await recordErasure(env, "acct_a", 100);
    expect(Object.keys(JSON.parse(await bodyOf(r2, "acct_a"))).sort()).toEqual([
      "accountId",
      "erasedAt",
      "v",
    ]);
    const head = await r2.head("erasures/acct_a");
    expect(head?.httpMetadata?.contentType).toBe("application/json");
    expect(head?.customMetadata).toEqual({});
  });

  it("refuses, naming the id, when the bucket is unbound, the write fails or the id is empty", async () => {
    const { env } = world();
    delete env.BLOBS;
    await expect(recordErasure(env, "acct_a", 1)).rejects.toThrow(
      /BLOBS bucket is not bound.*acct_a/,
    );

    class Down extends R2Mock {
      override async put(): Promise<R2Object | null> {
        throw new Error("R2 5xx");
      }
    }
    const down = world(new Down());
    const err = await recordErasure(down.env, "acct_a", 1).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ErasureLedgerError);
    expect((err as Error).message).toMatch(/acct_a.*R2 5xx/);
    expect(((err as Error).cause as Error).message).toBe("R2 5xx");

    await expect(recordErasure(world().env, "", 1)).rejects.toThrow(
      ErasureLedgerError,
    );
  });

  it("is a key no other writer can produce: the blob store refuses the prefix", async () => {
    const { r2 } = world();
    const key = erasureKey("acct_a");
    expect(key).toBe("erasures/acct_a");
    expect(parseKey(key)).toBeNull();
    const bytes = new TextEncoder().encode("not a ledger record");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    expect(
      await putVerified(asR2(r2), key, bytes, { sha256, size: bytes.length }),
    ).toMatchObject({ ok: false, reason: "key_mismatch" });
    expect(r2.keys()).toEqual([]);
  });
});

describe("replayErasureLedger: the ledger applied back to D1", () => {
  it("recreates the id-only tombstone of every listed id and never rewrites a row that is there", async () => {
    const { db, env } = world();
    for (const id of ["acct_a", "acct_b", "acct_c"])
      await recordErasure(env, id, 100);
    await db.run(
      `INSERT INTO account_tombstones (id, email_hash, merged_into, deleted_at)
       VALUES ('acct_b', NULL, NULL, 5), ('acct_c', 'h', 'acct_x', 7)`,
    );
    const r = await replayErasureLedger({ db, env }, eraser(db));
    expect(r).toEqual({
      scanned: 3,
      tombstoned: 1,
      reapplied: 0,
      deferred: 0,
      mirrored: 0,
      more: false,
      failures: [],
    });
    expect(
      await db.all(
        "SELECT id, email_hash, merged_into, deleted_at FROM account_tombstones ORDER BY id",
      ),
    ).toEqual([
      // The record's own time (R2's upload clock, seconds), never the replay's.
      {
        id: "acct_a",
        email_hash: null,
        merged_into: null,
        deleted_at: expect.closeTo(Date.now() / 1000, -2),
      },
      { id: "acct_b", email_hash: null, merged_into: null, deleted_at: 5 },
      { id: "acct_c", email_hash: "h", merged_into: "acct_x", deleted_at: 7 },
    ]);
  });

  it("walks a ledger longer than one R2 page by cursor, with the production page size", async () => {
    const spy = new ListSpy();
    const { db, env } = world(spy);
    const n = ERASURE_LEDGER_PAGE + 250;
    for (const id of range(1, n)) await recordErasure(env, id, NOW);
    const r = await replayErasureLedger({ db, env }, eraser(db));
    expect(r).toMatchObject({ scanned: n, tombstoned: n, more: false });
    expect(spy.lists).toHaveLength(2);
    expect(spy.lists.map((l) => l.limit)).toEqual([1000, 1000]);
    expect(spy.lists[0]).not.toHaveProperty("cursor");
    expect(typeof spy.lists[1]!.cursor).toBe("string");
    expect(await erasureTombstones(db)).toEqual(range(1, n));
  });

  it("handles every id once per pass, page by page", async () => {
    const spy = new ListSpy();
    const { db, env } = world(spy);
    for (const id of range(1, 7)) await recordErasure(env, id, NOW);
    const r = await replayErasureLedger({ db, env }, eraser(db), {
      pageSize: 2,
    });
    expect(r).toMatchObject({ scanned: 7, tombstoned: 7, more: false });
    expect(spy.lists).toHaveLength(4);
    expect(spy.lists.every((l) => l.prefix === ERASURE_PREFIX)).toBe(true);
    expect(spy.lists.map((l) => l.limit)).toEqual([2, 2, 2, 2]);
    expect(await erasureTombstones(db)).toEqual(range(1, 7));
  });

  it("stops at its page bound, remembers where, and resumes after the last key it read", async () => {
    const spy = new ListSpy();
    const { db, env, kv } = world(spy);
    for (const id of range(1, 7)) await recordErasure(env, id, NOW);
    const bounds: Partial<ReplayBounds> = { pageSize: 2, maxPages: 2 };
    const replay = () => replayErasureLedger({ db, env }, eraser(db), bounds);

    expect(await replay()).toMatchObject({
      scanned: 4,
      tombstoned: 4,
      more: true,
    });
    expect(await erasureTombstones(db)).toEqual(range(1, 4));
    expect(kv.keys()).toHaveLength(1);

    expect(await replay()).toMatchObject({
      scanned: 3,
      tombstoned: 3,
      more: false,
    });
    expect(spy.lists[2]).toMatchObject({ startAfter: erasureKey(acct(4)) });
    expect(spy.lists[2]).not.toHaveProperty("cursor");
    expect(await erasureTombstones(db)).toEqual(range(1, 7));
    expect(kv.keys()).toEqual([]);

    // A finished cycle starts again from the first key.
    expect(await replay()).toMatchObject({
      scanned: 4,
      tombstoned: 0,
      more: true,
    });
    expect(spy.lists[4]).not.toHaveProperty("startAfter");
  });

  it("a second pass over a consistent state changes nothing: no D1 write, no R2 write", async () => {
    const { db, env, r2 } = world();
    for (const id of range(1, 3)) await recordErasure(env, id, NOW);
    await replayErasureLedger({ db, env }, eraser(db));
    const writes = r2.putAttempts.length;
    const again = await replayErasureLedger({ db, env }, eraser(db));
    expect(again).toEqual({
      scanned: 3,
      tombstoned: 0,
      reapplied: 0,
      deferred: 0,
      mirrored: 0,
      more: false,
      failures: [],
    });
    expect(r2.putAttempts).toHaveLength(writes);
  });

  it("hands live accounts to the erasure state machine in id order and leaves an erasing one to its sweeper", async () => {
    const { db, env } = world();
    for (const id of range(1, 4)) await recordErasure(env, id, NOW);
    await seedAccount(db, acct(3));
    await seedAccount(db, acct(1), "disabled");
    await seedAccount(db, acct(2), "deleted"); // already erasing: the sweeper owns it
    const erase = eraser(db);
    const r = await replayErasureLedger({ db, env }, erase);
    expect(erase.calls).toEqual([acct(1), acct(3)]);
    expect(r).toMatchObject({ scanned: 4, reapplied: 2, failures: [] });
    expect(await column(db, "SELECT id FROM accounts ORDER BY id")).toEqual([
      acct(2),
    ]);
  });

  it("bounds the accounts it re-erases per pass; the rest wait, and the resume point does not move past them", async () => {
    const { db, env, kv } = world();
    for (const id of range(1, 6)) await recordErasure(env, id, NOW);
    await seedAccount(db, acct(1));
    await seedAccount(db, acct(2));
    await seedAccount(db, acct(3), "deleted");
    const erase = eraser(db);
    const replay = () =>
      replayErasureLedger({ db, env }, erase, {
        pageSize: 2,
        maxPages: 1,
        maxReapply: 1,
      });

    // Page one holds two live accounts; one is deferred, so the next pass reads the page again.
    expect(await replay()).toMatchObject({
      scanned: 2,
      reapplied: 1,
      deferred: 1,
      more: true,
    });
    expect(kv.keys()).toEqual([]);
    // Now it moves on, remembering the last key of the page it finished.
    expect(await replay()).toMatchObject({
      reapplied: 1,
      deferred: 0,
      more: true,
    });
    expect(erase.calls).toEqual([acct(1), acct(2)]);
    expect([...kv.keys()]).toHaveLength(1);
    // The erasing account on page two is not the replay's.
    expect(await replay()).toMatchObject({ reapplied: 0, more: true });
    expect(erase.calls).toEqual([acct(1), acct(2)]);
  });

  it("collects an account that fails by its opaque id and carries on with the rest", async () => {
    const { db, env } = world();
    for (const id of range(1, 3)) await recordErasure(env, id, NOW);
    for (const id of range(1, 3)) await seedAccount(db, id);
    const calls: string[] = [];
    const r = await replayErasureLedger({ db, env }, async (accountId) => {
      calls.push(accountId);
      if (accountId === acct(2)) throw new Error(`D1 down ${"x".repeat(400)}`);
      await db.run("DELETE FROM accounts WHERE id = ?", accountId);
      return { ok: true };
    });
    expect(calls).toEqual([acct(1), acct(2), acct(3)]);
    expect(r.reapplied).toBe(2);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toMatchObject({
      accountId: acct(2),
      step: "reapply",
    });
    expect(r.failures[0]!.message.length).toBeLessThanOrEqual(160);
    expect(await column(db, "SELECT id FROM accounts")).toEqual([acct(2)]);
  });

  it("copies the erasure tombstones the ledger lacks into it, range by range, and never a merge tombstone", async () => {
    const { db, env, r2 } = world();
    for (const id of ["b", "d", "f"]) await recordErasure(env, id, 50);
    await db.run(
      `INSERT INTO account_tombstones (id, email_hash, merged_into, deleted_at)
       VALUES ('a', NULL, NULL, 1), ('b', NULL, NULL, 2), ('c', NULL, NULL, 3), ('d', NULL, NULL, 4),
              ('e', NULL, NULL, 5), ('f', NULL, NULL, 6), ('g', NULL, NULL, 7),
              ('h', 'hash', 'a', 8)`,
    );
    const r = await replayErasureLedger({ db, env }, eraser(db), {
      pageSize: 2,
    });
    // Page one lists b and d (and covers up to d): a and c are missing. The last page lists f
    // and covers everything after d: e and g.
    expect(r).toMatchObject({ scanned: 3, mirrored: 4, failures: [] });
    expect(ledgerIds(r2)).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
    expect(JSON.parse(await bodyOf(r2, "c"))).toEqual({
      v: 1,
      accountId: "c",
      erasedAt: 3,
    });
    // The records the ledger already held are untouched.
    expect(JSON.parse(await bodyOf(r2, "b")).erasedAt).toBe(50);
    // Idempotent.
    const writes = r2.putAttempts.length;
    expect(
      await replayErasureLedger({ db, env }, eraser(db), { pageSize: 2 }),
    ).toMatchObject({ scanned: 7, mirrored: 0 });
    expect(r2.putAttempts).toHaveLength(writes);
  });

  it("copies at most its bound per pass into an empty ledger and finishes over later passes", async () => {
    const { db, env, r2 } = world();
    for (const id of range(1, 5))
      await db.run(
        "INSERT INTO account_tombstones (id, email_hash, merged_into, deleted_at) VALUES (?, NULL, NULL, ?)",
        id,
        10,
      );
    const mirror = () =>
      replayErasureLedger({ db, env }, eraser(db), { maxMirror: 2 });
    expect((await mirror()).mirrored).toBe(2);
    expect(ledgerIds(r2)).toEqual(range(1, 2));
    expect((await mirror()).mirrored).toBe(2);
    expect((await mirror()).mirrored).toBe(1);
    expect(ledgerIds(r2)).toEqual(range(1, 5));
    expect((await mirror()).mirrored).toBe(0);
  });

  it("reports a ledger copy that fails by id and still finishes the pass", async () => {
    class NoMirror extends R2Mock {
      override async put(...args: Parameters<R2Mock["put"]>) {
        if (args[0] === erasureKey("b")) throw new Error("R2 5xx");
        return super.put(...args);
      }
    }
    const { db, env, r2 } = world(new NoMirror());
    for (const id of ["a", "b", "c"])
      await db.run(
        "INSERT INTO account_tombstones (id, email_hash, merged_into, deleted_at) VALUES (?, NULL, NULL, 1)",
        id,
      );
    const r = await replayErasureLedger({ db, env }, eraser(db));
    expect(r.mirrored).toBe(2);
    expect(r.failures).toEqual([
      {
        accountId: "b",
        step: "mirror",
        message: expect.stringContaining("R2 5xx"),
      },
    ]);
    expect(ledgerIds(r2)).toEqual(["a", "c"]);
  });

  it("reads only ledger records: a key outside the prefix or without an id is not an account", async () => {
    const { db, env, r2 } = world();
    r2.seed("erasures/", new Uint8Array());
    r2.seed("blobs/sha256/abc", new Uint8Array());
    r2.seed("avatars/x", new Uint8Array());
    await recordErasure(env, "acct_ok", NOW);
    const r = await replayErasureLedger({ db, env }, eraser(db));
    expect(r).toMatchObject({ scanned: 1, tombstoned: 1 });
    expect(await erasureTombstones(db)).toEqual(["acct_ok"]);
  });

  it("does nothing without a bucket: there is no ledger, and none was written", async () => {
    const { db, env } = world();
    delete env.BLOBS;
    const erase = eraser(db);
    expect(await replayErasureLedger({ db, env }, erase)).toEqual({
      scanned: 0,
      tombstoned: 0,
      reapplied: 0,
      deferred: 0,
      mirrored: 0,
      more: false,
      failures: [],
    });
    expect(erase.calls).toEqual([]);
  });

  it("throws, rather than reporting success, when the bucket or the database cannot be read", async () => {
    class DownList extends R2Mock {
      override async list(): Promise<R2Objects> {
        throw new Error("R2 5xx on list");
      }
    }
    const down = world(new DownList());
    await expect(
      replayErasureLedger({ db: down.db, env: down.env }, eraser(down.db)),
    ).rejects.toThrow("R2 5xx on list");

    const { db, env } = world();
    await recordErasure(env, "acct_a", NOW);
    const broken: Db = {
      ...db,
      all: db.all.bind(db),
      first: db.first.bind(db),
      run: db.run.bind(db),
      batch: db.batch.bind(db),
      runChanges: async () => {
        throw new Error("D1 down");
      },
    };
    await expect(
      replayErasureLedger({ db: broken, env }, eraser(db)),
    ).rejects.toThrow("D1 down");
  });

  it("works through a KV that is down: the resume marker is an optimisation, never a dependency", async () => {
    class DownKv extends KvMock {
      override async get(): Promise<string | null> {
        throw new Error("KV down");
      }
      override async put(): Promise<void> {
        throw new Error("KV down");
      }
      override async delete(): Promise<void> {
        throw new Error("KV down");
      }
    }
    const { db, env } = world(new R2Mock(), new DownKv());
    for (const id of range(1, 5)) await recordErasure(env, id, NOW);
    const r = await replayErasureLedger({ db, env }, eraser(db), {
      pageSize: 2,
      maxPages: 1,
    });
    expect(r).toMatchObject({ scanned: 2, tombstoned: 2, more: true });
  });

  it("round-trips an id as it is: the key is the prefix and the id, whatever the id holds", async () => {
    const { db, env, r2 } = world();
    const odd = "acct/with slash and space ü";
    await recordErasure(env, odd, NOW);
    expect(r2.keys()).toEqual([`erasures/${odd}`]);
    expect(await replayErasureLedger({ db, env }, eraser(db))).toMatchObject({
      scanned: 1,
      tombstoned: 1,
      mirrored: 0,
    });
    expect(await erasureTombstones(db)).toEqual([odd]);
  });

  it("walks past a page that is empty yet truncated instead of mistaking it for the end", async () => {
    class EmptyFirst extends R2Mock {
      private emptied = false;
      override async list(options?: R2ListOptions): Promise<R2Objects> {
        if (!this.emptied) {
          this.emptied = true;
          return {
            objects: [],
            delimitedPrefixes: [],
            truncated: true,
            cursor: ERASURE_PREFIX,
          };
        }
        return super.list(options);
      }
    }
    const { db, env } = world(new EmptyFirst());
    for (const id of range(1, 3)) await recordErasure(env, id, NOW);
    const r = await replayErasureLedger({ db, env }, eraser(db), {
      pageSize: 2,
    });
    expect(r).toMatchObject({ scanned: 3, tombstoned: 3, more: false });
    expect(await erasureTombstones(db)).toEqual(range(1, 3));
  });

  it("a ledger that fits its page bound exactly does not claim there is more", async () => {
    const { db, env, kv } = world();
    for (const id of range(1, 4)) await recordErasure(env, id, NOW);
    const r = await replayErasureLedger({ db, env }, eraser(db), {
      pageSize: 2,
      maxPages: 2,
    });
    expect(r).toMatchObject({ scanned: 4, more: false });
    expect(kv.keys()).toEqual([]);
  });

  it("counts only the accounts the erasure state machine accepted", async () => {
    const { db, env } = world();
    await recordErasure(env, acct(1), NOW);
    await seedAccount(db, acct(1));
    // The account vanished between the read and the call (another pass erased it first).
    const r = await replayErasureLedger({ db, env }, async () => ({
      ok: false,
    }));
    expect(r).toMatchObject({ reapplied: 0, failures: [] });
  });
});

describe("erasure tombstones are never purged", () => {
  it("a tombstone the replay recreated survives the 90-day purge however old", async () => {
    const { db, env } = world();
    await recordErasure(env, "acct_legacy", NOW);
    // The restore left no account row and no tombstone for this person.
    // A merge tombstone past its retention, for contrast.
    await db.run(
      `INSERT INTO account_tombstones (id, email_hash, merged_into, deleted_at)
       VALUES ('acct_merged', 'h', 'acct_other', 1)`,
    );
    await replayErasureLedger({ db, env }, eraser(db));

    const far =
      Math.floor(Date.now() / 1000) + 10 * TOMBSTONE_RETENTION_SECONDS;
    await purgePrivacyResidue(db, far);
    expect(await column(db, "SELECT id FROM account_tombstones")).toEqual([
      "acct_legacy",
    ]);
  });
});
