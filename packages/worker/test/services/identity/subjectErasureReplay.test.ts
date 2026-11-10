/// <reference types="@cloudflare/workers-types" />
/**
 * U-12.2: the per-product removal ledger's replay. A D1 restore brings a removed subject's rows
 * back while the ledger (R2) and the Cloud Sync object (a Durable Object, which Time Travel does
 * not touch) survive; one pass removes the rows again and the object stays erased. Also pinned:
 * the 25-subject bound and its cursor, the 35-day sweep, that the two ledgers never read each
 * other's entries, and the objects pass after a Durable Object restore.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  registerSubjectStore,
  unregisterSubjectStore,
} from "../../../src/core/accounts/subjectHooks.js";
import { NOW } from "../../seed.js";
import type { Db } from "../../../src/db/types.js";
import {
  asCloudSyncNamespace,
  CloudSyncNamespaceMock,
  ERASED_LEFTOVERS,
  erasureLeftovers,
} from "../../cloudSyncDoMock.js";
import { replayErasureLedger } from "../../../src/services/identity/accounts/erasureLedger.js";
import {
  completeProductRemoval,
  replaySubjectRemovals,
} from "../../../src/services/identity/accounts/productRemoval.js";
import {
  OBJECTS_REQUEST_KEY,
  recordSubjectErasure,
  replaySubjectErasures,
  SUBJECT_ERASURE_PREFIX,
  SUBJECT_ERASURE_RETENTION_SECONDS,
  subjectErasureKey,
} from "../../../src/services/identity/accounts/subjectErasureLedger.js";
import {
  P,
  remove,
  resetState,
  state,
  populate,
  subjectRow,
  unregisterProbes,
  world,
  type World,
} from "./fixtures/productRemovalWorld.js";

beforeEach(resetState);
afterEach(unregisterProbes);

/** A live subject row for a stand-in account (what a restore brings back). */
async function upsertAccountSubject(
  db: Db,
  accountId: string,
  product: string,
  subject: string,
) {
  await db.run(
    "INSERT OR IGNORE INTO accounts (id, status, created_at, modified_at) VALUES (?, 'active', ?, ?)",
    accountId,
    NOW,
    NOW,
  );
  await db.run(
    "INSERT INTO account_product_subjects (account_id, product, subject, created_at) VALUES (?, ?, ?, ?)",
    accountId,
    product,
    subject,
    NOW,
  );
}
const pairwise = (n: number) => `ps_${String(n).padStart(22, "0")}`;

const TABLES = [
  "account_product_subjects",
  "account_product_subject_aliases",
  "account_overrides",
  "devices",
];

/** Rows a D1 restore would bring back, captured before the removal. */
async function snapshot(w: World) {
  const out: Record<string, Array<Record<string, unknown>>> = {};
  for (const t of TABLES)
    out[t] = await w.db.all<Record<string, unknown>>(`SELECT * FROM ${t}`);
  return out;
}

async function restore(w: World, snap: Awaited<ReturnType<typeof snapshot>>) {
  for (const [table, rows] of Object.entries(snap))
    for (const row of rows) {
      const cols = Object.keys(row);
      await w.db.run(
        `INSERT OR REPLACE INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
        ...cols.map((c) => row[c] as never),
      );
    }
}

async function withDo(): Promise<{ w: World; ns: CloudSyncNamespaceMock }> {
  const w = await world();
  const ns = new CloudSyncNamespaceMock();
  w.env.CLOUD_SYNC = asCloudSyncNamespace(ns);
  return { w, ns };
}

describe("after a D1 restore", () => {
  it("removes the restored rows again and leaves the object erased", async () => {
    const { w, ns } = await withDo();
    state.failing = false;
    await populate(w, w.subject);
    await w.db.run(
      `INSERT INTO account_overrides (product, subject, payload_json, updated_at, updated_by)
       VALUES (?, ?, '{"config":{}}', ?, 'operator')`,
      P,
      w.subject,
      NOW,
    );
    const snap = await snapshot(w);
    expect(snap.devices!.some((d) => d.subject === w.subject)).toBe(true);

    expect((await remove(w)).pending).toBeUndefined();
    expect(await subjectRow(w)).toBeNull();
    expect(erasureLeftovers(ns, `${P}:${w.subject}`)).toEqual(ERASED_LEFTOVERS);

    await restore(w, snap);
    expect(await subjectRow(w)).not.toBeNull();
    expect(
      await w.db.first(
        "SELECT 1 FROM account_overrides WHERE subject = ?",
        w.subject,
      ),
    ).not.toBeNull();

    const r = await replaySubjectRemovals(w.ctx());
    expect(r).toMatchObject({
      scanned: 1,
      completed: 1,
      failures: [],
      more: false,
    });
    expect(await subjectRow(w)).toBeNull();
    expect(
      await w.db.first(
        "SELECT 1 FROM account_overrides WHERE subject = ?",
        w.subject,
      ),
    ).toBeNull();
    expect(
      await w.db.all("SELECT 1 FROM devices WHERE subject = ?", w.subject),
    ).toHaveLength(0);
    expect(erasureLeftovers(ns, `${P}:${w.subject}`)).toEqual(ERASED_LEFTOVERS);

    // A second pass finds nothing owed.
    expect(await replaySubjectRemovals(w.ctx())).toMatchObject({
      scanned: 1,
      completed: 0,
      swept: 0,
    });
  });

  it("finishes a removal a failing store left owed", async () => {
    const { w } = await withDo();
    expect((await remove(w)).pending).toBe(true);
    // Still failing: the pass reports the store by name, never an account.
    const stuck = await replaySubjectRemovals(w.ctx());
    expect(stuck.completed).toBe(0);
    expect(stuck.failures).toHaveLength(1);
    expect(stuck.failures[0]).toMatchObject({ product: P, subject: w.subject });
    expect(JSON.stringify(stuck)).not.toContain(w.accountId);
    state.failing = false;
    expect((await replaySubjectRemovals(w.ctx())).completed).toBe(1);
    expect(await subjectRow(w)).toBeNull();
    expect(state.deletedBy.filter((n) => n === "z.flaky")).toHaveLength(1);
  });
});

describe("bounds, cursor and sweep", () => {
  /** n owed removals: a live subject row each, and a ledger entry. */
  async function owed(w: World, from: number, n: number) {
    for (let i = from; i < from + n; i++) {
      await upsertAccountSubject(w.db, `acct_${i}`, P, pairwise(i));
      await recordSubjectErasure(w.env, P, pairwise(i), NOW);
    }
  }

  it("completes at most 25 subjects a pass and resumes from the cursor", async () => {
    const { w } = await withDo();
    state.failing = false;
    await owed(w, 1000, 30);
    const first = await replaySubjectRemovals(w.ctx());
    expect(first).toMatchObject({ completed: 25, more: true, failures: [] });
    const left = await w.db.all(
      "SELECT 1 FROM account_product_subjects WHERE subject LIKE 'ps_000000000000000000%'",
    );
    expect(left).toHaveLength(5);
    const second = await replaySubjectRemovals(w.ctx());
    expect(second).toMatchObject({ completed: 5, more: false });
    expect(
      await w.db.all(
        "SELECT 1 FROM account_product_subjects WHERE subject LIKE 'ps_000000000000000000%'",
      ),
    ).toHaveLength(0);
  });

  it("stops at its page bound and the next pass continues after the last entry it read", async () => {
    const { w } = await withDo();
    state.failing = false;
    await owed(w, 2000, 6);
    const run = () =>
      replaySubjectErasures(
        w.ctx(),
        (a) => completeProductRemoval(w.ctx(), a),
        {},
        { pageSize: 2, maxPages: 2 },
      );
    expect(await run()).toMatchObject({ scanned: 4, completed: 4, more: true });
    expect(await run()).toMatchObject({ completed: 2, more: false });
    expect(
      await w.db.all(
        "SELECT 1 FROM account_product_subjects WHERE subject LIKE 'ps_0000%'",
      ),
    ).toHaveLength(0);
  });

  it("sweeps entries past 35 days whose subject is gone, and keeps the rest", async () => {
    const { w } = await withDo();
    await recordSubjectErasure(w.env, P, pairwise(1), NOW);
    await recordSubjectErasure(w.env, P, pairwise(2), NOW);
    // A removal still owed is not swept, however old.
    await upsertAccountSubject(w.db, "acct_old", P, pairwise(3));
    await recordSubjectErasure(w.env, P, pairwise(3), NOW);
    state.failing = true;
    // R2 stamps an entry with the wall clock; age is the pass's `now` minus that.
    const wall = Math.floor(Date.now() / 1000);
    const early = await replaySubjectRemovals(
      w.ctx(wall + SUBJECT_ERASURE_RETENTION_SECONDS - 60),
    );
    expect(early.swept).toBe(0);
    const late = await replaySubjectRemovals(
      w.ctx(wall + SUBJECT_ERASURE_RETENTION_SECONDS + 60),
    );
    expect(late.swept).toBe(2);
    expect(w.r2.keys()).toEqual([subjectErasureKey(P, pairwise(3))]);
  });

  it("the account replay ignores subject-erasures/ and this pass ignores erasures/", async () => {
    const { w } = await withDo();
    await recordSubjectErasure(w.env, P, pairwise(1), NOW);
    w.r2.seed("erasures/acct_zzz", new Uint8Array());
    w.r2.seed(`${SUBJECT_ERASURE_PREFIX}${P}/not-a-subject`, new Uint8Array());
    const seen: string[] = [];
    const accounts = await replayErasureLedger(w.ctx(), async (id) => {
      seen.push(id);
      return { ok: true };
    });
    expect(accounts.scanned).toBe(1);
    expect(seen).toEqual([]);
    const subjects = await replaySubjectRemovals(w.ctx());
    expect(subjects.scanned).toBe(1);
    expect(w.r2.keys()).toContain("erasures/acct_zzz");
  });
});

describe("after a Durable Object restore", () => {
  it("the normal pass skips an object D1 no longer names; the objects pass erases it", async () => {
    const { w, ns } = await withDo();
    state.failing = false;
    // The ledger names the subject, D1 has no row for it, and the object holds data again.
    const subject = pairwise(7);
    await recordSubjectErasure(w.env, P, subject, NOW);
    await populate(w, subject);
    const other = pairwise(8);
    await populate(w, other);

    const normal = await replaySubjectRemovals(w.ctx());
    expect(normal).toMatchObject({ completed: 0, objects: 0, failures: [] });
    expect(erasureLeftovers(ns, `${P}:${subject}`)).not.toEqual(
      ERASED_LEFTOVERS,
    );

    const full = await replaySubjectRemovals(w.ctx(), {
      objects: true,
      product: P,
    });
    expect(full).toMatchObject({ objects: 1, failures: [], more: false });
    expect(erasureLeftovers(ns, `${P}:${subject}`)).toEqual(ERASED_LEFTOVERS);
    // A subject the ledger does not name is not touched.
    expect(erasureLeftovers(ns, `${P}:${other}`)).not.toEqual(ERASED_LEFTOVERS);
    expect(OBJECTS_REQUEST_KEY).toContain("subject-erasure-ledger");
  });
});

describe("the objects pass cycle", () => {
  const entries = async (
    w: World,
    product: string,
    from: number,
    n: number,
  ) => {
    for (let i = from; i < from + n; i++)
      await recordSubjectErasure(w.env, product, pairwise(i), NOW);
  };
  const run = (
    w: World,
    product: string,
    complete: (a: {
      product: string;
      subject: string;
    }) => Promise<{ removed: boolean }>,
    now = NOW,
  ) =>
    replaySubjectErasures(
      { db: w.db, env: w.env, now },
      complete,
      { objects: true, product },
      { maxComplete: 1 },
    );

  it("keeps its cursor per product", async () => {
    const { w } = await withDo();
    state.failing = false;
    await entries(w, "zzz", 3000, 2);
    await entries(w, "aaa", 3100, 1);
    const none = async () => ({ removed: false });
    // zzz stops at its bound and leaves a cursor; aaa must still be walked from its first entry.
    expect(await run(w, "zzz", none)).toMatchObject({ more: true });
    expect(await run(w, "aaa", none)).toMatchObject({
      scanned: 1,
      objects: 1,
      more: false,
    });
  });

  it("is spent only by a cycle without a failure", async () => {
    const { w } = await withDo();
    state.failing = false;
    await entries(w, "aaa", 3200, 2);
    // Both entries are unknown to D1, so the stores run; make the first fail through a store.
    registerSubjectStore("a.fails", {
      merge: async () => {},
      delete: async (_c, { subject }) => {
        if (subject === pairwise(3200)) throw new Error("down");
      },
    });
    try {
      const none = async () => ({ removed: false });
      const first = await run(w, "aaa", none);
      expect(first).toMatchObject({ more: true, cycleFailed: true });
      const second = await run(w, "aaa", none);
      expect(second).toMatchObject({
        more: false,
        failures: [],
        cycleFailed: true,
      });
      // The next cycle starts clean and, with the store healthy, ends clean.
      unregisterSubjectStore("a.fails");
      await run(w, "aaa", none);
      expect(await run(w, "aaa", none)).toMatchObject({
        more: false,
        cycleFailed: false,
      });
    } finally {
      unregisterSubjectStore("a.fails");
    }
  });

  it("counts removals owed for more than a week", async () => {
    const { w } = await withDo();
    state.failing = true;
    await upsertAccountSubject(w.db, "acct_stale", P, pairwise(3300));
    await recordSubjectErasure(w.env, P, pairwise(3300), NOW);
    const wall = Math.floor(Date.now() / 1000);
    expect(await replaySubjectRemovals(w.ctx(wall + 3600))).toMatchObject({
      stale: 0,
    });
    expect(
      await replaySubjectRemovals(w.ctx(wall + 8 * 24 * 3600)),
    ).toMatchObject({ stale: 1 });
  });
});
