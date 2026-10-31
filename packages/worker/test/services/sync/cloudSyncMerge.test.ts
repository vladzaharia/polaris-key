/**
 * U-05.8: the survivor of an account merge absorbs the absorbed subject's Cloud Sync object
 * (`sync.cloudSync` store `merge`, `engine/absorb.ts`, the object's `absorb` op). Covers the join
 * rules, L8 (keep everything, refuse later growth), retry-safety at every crash point, a write
 * that lands on the absorbed object mid-merge, and the real account merge end to end.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { ABSORBED_RETENTION_MS } from "../../../src/services/sync/do/cloudSyncDo.js";
import { describe, expect, it } from "vitest";
import "../../../src/index.js";
import type { SyncMutation } from "@polaris-key/protocol/sync";
import { runSubjectMerge } from "../../../src/core/accounts/subjectHooks.js";
import {
  absorbSettings,
  joinRows,
} from "../../../src/services/sync/engine/absorb.js";
import { MemoryStore } from "../../../src/services/sync/engine/memoryStore.js";
import { formatHlc } from "../../../src/services/sync/engine/hlc.js";
import type {
  Classification,
  StoredSetting,
} from "../../../src/services/sync/engine/types.js";
import {
  absorbCloudSync,
  callCloudSync,
  deleteCloudSync,
  deleteCloudSyncIfUnchanged,
  exportCloudSync,
} from "../../../src/services/sync/do/client.js";
import type { ExportDocument } from "../../../src/services/sync/do/protocol.js";
import { signIn } from "../../../src/services/identity/accounts/signIn.js";
import { mergeAccounts } from "../../../src/services/identity/accounts/merge.js";
import { makeTestDb } from "../../helpers.js";
import { KvMock } from "../../kvMock.js";
import { makeEnv, seedProduct, NOW } from "../../seed.js";
import {
  CloudSyncNamespaceMock,
  asCloudSyncNamespace,
  ERASED_LEFTOVERS,
  erasureLeftovers,
} from "../../cloudSyncDoMock.js";
import { TEST_ROOT } from "../../paths.js";

const P = "acme";
const T0 = 1_760_000_000_000;
const C1 = "c_000000000000000client1";
const C2 = "c_000000000000000client2";
const LAST: Classification = {
  verdict: "accept",
  scope: "user",
  policy: "lastWrite",
};
const MERGE: Classification = {
  verdict: "accept",
  scope: "user",
  policy: "merge",
};
const at = (n: number) => formatHlc(T0 + n * 1000, 0);

let nextId = 1;
const mut = (
  key: string,
  op: SyncMutation["op"],
  hlc: string,
  extra: Partial<SyncMutation> = {},
): SyncMutation => ({
  mutationId: nextId++,
  target: { setting: key, scope: "user" },
  op,
  editedHlc: hlc,
  ...extra,
});

type Cs = { CLOUD_SYNC: DurableObjectNamespace };
const world = () => {
  const ns = new CloudSyncNamespaceMock();
  const env: Cs = { CLOUD_SYNC: asCloudSyncNamespace(ns) };
  return { ns, env };
};

async function push(
  env: Cs,
  subject: string,
  mutations: SyncMutation[],
  classified: Classification[],
  o: { clientId?: string; deviceId?: string; limits?: unknown } = {},
) {
  const r = await callCloudSync<"push">(
    env,
    { product: P, subject },
    {
      op: "push",
      deviceId: o.deviceId ?? "d1",
      family: "desktop",
      limits: (o.limits as never) ?? { quotaBytes: 1_000_000_000 },
      request: { clientId: o.clientId ?? C1, cursor: 0, mutations },
      classified,
      serverNow: T0 + 3_600_000,
    },
  );
  return r.outcome;
}

const setOne = (
  env: Cs,
  subject: string,
  key: string,
  value: unknown,
  hlc: string,
  clientId = C1,
  deviceId = "d1",
) =>
  push(
    env,
    subject,
    [mut(key, "set", hlc, { value: value as never })],
    [LAST],
    {
      clientId,
      deviceId,
    },
  );

async function dump(env: Cs, subject: string) {
  const d = await exportCloudSync(env, { product: P, subject });
  if (!d) return null;
  return Object.fromEntries(
    d.settings.map((r) => [
      r.key,
      {
        deleted: r.deleted,
        value: r.members
          ? Object.fromEntries(
              r.members
                .filter(([, c]) => !c.removed)
                .map(([n, c]) => [n, c.value]),
            )
          : r.value,
        stamp: r.stamp,
      },
    ]),
  );
}

const merge = (env: Cs, from: string, to: string, db = makeTestDb()) =>
  runSubjectMerge({ db, env: env as never, now: 1 }, { product: P, from, to });

describe("absorb: the join", () => {
  it("the survivor ends with both people's settings and the absorbed object is gone", async () => {
    const { ns, env } = world();
    await setOne(env, "to", "theme", "dark", at(1));
    await setOne(env, "from", "lang", "fr", at(2), C2, "d2");
    await merge(env, "from", "to");
    expect(await dump(env, "to")).toMatchObject({
      theme: { value: "dark" },
      lang: { value: "fr" },
    });
    expect(await dump(env, "from")).toBeNull();
    // What is left of the absorbed object is the pin and the marker: no row, no client binding.
    const gone = ns.instance(`${P}:from`);
    const db = gone.storage.sql.db;
    for (const t of ["settings", "tombstones", "setting_members", "clients"])
      expect(db.prepare(`SELECT count(*) AS n FROM ${t}`).get(), t).toEqual({
        n: 0,
      });
    const meta = Object.fromEntries(
      (
        db.prepare("SELECT key, value FROM meta").all() as {
          key: string;
          value: string;
        }[]
      ).map((r) => [r.key, r.value]),
    );
    expect(Object.keys(meta).sort()).toEqual([
      "absorbed_at",
      "absorbed_into",
      "product",
      "schema_version",
      "subject",
    ]);
    expect(meta).toMatchObject({
      product: P,
      subject: "from",
      absorbed_into: "to",
    });
    // The only alarm left is the marker's own cleanup, 30 days on (U-05.9); no flush is owed.
    expect(gone.storage.alarm).toBe(
      Number(meta.absorbed_at) + ABSORBED_RETENTION_MS,
    );
  });

  it("a merged object refuses every later push and absorb with 410 absorbed, reads empty, and an erasure removes the marker (SR-1 N3)", async () => {
    const { ns, env } = world();
    await setOne(env, "from", "a", 1, at(1), C2, "d2");
    await merge(env, "from", "to");
    // The late write the survivor never sees is refused, not stored.
    await expect(
      setOne(env, "from", "late", 2, at(5), C2, "d2"),
    ).rejects.toMatchObject({
      status: 410,
      code: "absorbed",
    });
    const to = (await exportCloudSync(env, { product: P, subject: "to" }))!;
    expect(to.settings.map((s) => s.key)).toEqual(["a"]);
    await expect(
      absorbCloudSync(
        env,
        { product: P, subject: "from" },
        { ...to, subject: "x" },
      ),
    ).rejects.toMatchObject({ status: 410, code: "absorbed" });
    // Reads answer empty; the export is nothing, so a retried merge settles at once.
    const pulled = await callCloudSync<"pull">(
      env,
      { product: P, subject: "from" },
      {
        op: "pull",
        cursor: 0,
        deviceId: "d2",
        family: "desktop",
        clientId: C2,
      },
    );
    expect(pulled.outcome).toMatchObject({ ok: true, changes: [] });
    expect(
      await exportCloudSync(env, { product: P, subject: "from" }),
    ).toBeNull();
    await merge(env, "from", "to");
    // Erasure replaces the merge marker with the erasure marker: no data, and writes stay refused.
    await deleteCloudSync(env, { product: P, subject: "from" });
    expect(erasureLeftovers(ns, `${P}:from`)).toEqual(ERASED_LEFTOVERS);
    await expect(
      setOne(env, "from", "fresh", 3, at(6), C2, "d2"),
    ).rejects.toMatchObject({ status: 410, code: "absorbed" });
  });

  it("a write that does not move the sequence (a conflict-only push) between export and delete keeps the object (SR-1 N2)", async () => {
    const { env } = world();
    await setOne(env, "from", "k", 1, at(5), C2, "d2");
    const doc = (await exportCloudSync(env, { product: P, subject: "from" }))!;
    await absorbCloudSync(env, { product: P, subject: "to" }, doc);
    // A stale write: a conflict, no seq bump, but the client's last mutation id advances.
    const r = await push(
      env,
      "from",
      [mut("k", "set", at(1), { value: 0 })],
      [LAST],
      {
        clientId: C2,
        deviceId: "d2",
      },
    );
    expect(r.ok && r.results[0]?.status).toBe("conflict");
    expect(
      await deleteCloudSyncIfUnchanged(
        env,
        { product: P, subject: "from" },
        { seq: doc.seq, writes: doc.writes },
        "to",
      ),
    ).toBe(false);
    // The merge goes round again and carries the new binding to the survivor.
    await merge(env, "from", "to");
    const pulled = await callCloudSync<"pull">(
      env,
      { product: P, subject: "to" },
      {
        op: "pull",
        cursor: 0,
        deviceId: "d2",
        family: "desktop",
        clientId: C2,
      },
    );
    expect(pulled.outcome).toMatchObject({
      ok: true,
      lastMutationId: nextId - 1,
    });
  });

  it("the survivor's object is created, pinned, when it never held data", async () => {
    const { ns, env } = world();
    await setOne(env, "from", "theme", "dark", at(1));
    await merge(env, "from", "to");
    expect(await dump(env, "to")).toMatchObject({ theme: { value: "dark" } });
    const meta = ns
      .instance(`${P}:to`)
      .storage.sql.db.prepare("SELECT key, value FROM meta")
      .all() as { key: string; value: string }[];
    expect(meta).toEqual(
      expect.arrayContaining([
        { key: "product", value: P },
        { key: "subject", value: "to" },
      ]),
    );
  });

  it("nothing is created when the absorbed object holds nothing", async () => {
    const { ns, env } = world();
    await merge(env, "from", "to");
    expect(await dump(env, "to")).toBeNull();
    expect(ns.instance(`${P}:to`).storage.sql.rowsWritten).toBe(0);
  });

  it("the later stamp wins a collision, in either direction; an equal HLC falls to the clientId", async () => {
    const { env } = world();
    await setOne(env, "to", "a", "survivor-newer", at(5));
    await setOne(env, "from", "a", "absorbed-older", at(4), C2, "d2");
    await setOne(env, "to", "b", "survivor-older", at(1));
    await setOne(env, "from", "b", "absorbed-newer", at(9), C2, "d2");
    // The same HLC on both sides: the greater clientId (C2) is the winner.
    await setOne(env, "to", "c", "by-c1", at(7));
    await setOne(env, "from", "c", "by-c2", at(7), C2, "d2");
    await merge(env, "from", "to");
    const d = await dump(env, "to");
    expect(d).toMatchObject({
      a: { value: "survivor-newer" },
      b: { value: "absorbed-newer" },
      c: { value: "by-c2" },
    });
  });

  it("a tombstone newer than the survivor's value deletes it; an older one does not", async () => {
    const { env } = world();
    await setOne(env, "to", "gone", 1, at(1));
    await setOne(env, "from", "gone", 1, at(0), C2, "d2");
    await push(env, "from", [mut("gone", "clear", at(5))], [LAST], {
      clientId: C2,
      deviceId: "d2",
    });
    await setOne(env, "to", "kept", 1, at(8));
    await setOne(env, "from", "kept", 1, at(0), C2, "d2");
    await push(env, "from", [mut("kept", "clear", at(2))], [LAST], {
      clientId: C2,
      deviceId: "d2",
    });
    await merge(env, "from", "to");
    expect(await dump(env, "to")).toMatchObject({
      gone: { deleted: true },
      kept: { deleted: false, value: 1 },
    });
  });

  it("a deletion survives in the survivor, so an older edit cannot bring the key back", async () => {
    const { env } = world();
    await setOne(env, "from", "k", "x", at(0), C2, "d2");
    await push(env, "from", [mut("k", "clear", at(5))], [LAST], {
      clientId: C2,
      deviceId: "d2",
    });
    await merge(env, "from", "to");
    const late = await setOne(env, "to", "k", "old", at(3));
    expect(late.ok && late.results[0]?.status).toBe("conflict");
  });

  it("merge rows: members union, each keeps its later cell, and a newer clear drops older cells", async () => {
    const { env } = world();
    const mem = (
      n: string,
      v: string,
      h: string,
      op: SyncMutation["op"] = "setMember",
    ) =>
      mut("keys", op, h, {
        member: n,
        ...(op === "setMember" ? { value: v } : {}),
      });
    await push(
      env,
      "to",
      [mem("jump", "space", at(1)), mem("fire", "z", at(6))],
      [MERGE, MERGE],
    );
    await push(
      env,
      "from",
      [
        mem("jump", "w", at(3)),
        mem("fire", "x", at(2)),
        mem("duck", "s", at(2)),
      ],
      [MERGE, MERGE, MERGE],
      { clientId: C2, deviceId: "d2" },
    );
    await merge(env, "from", "to");
    expect((await dump(env, "to"))!.keys!.value).toEqual({
      jump: "w",
      fire: "z",
      duck: "s",
    });

    // A clear on the absorbed side drops the survivor's older cells but not its newer ones.
    const w2 = world();
    await push(
      w2.env,
      "to",
      [mem("a", "1", at(1)), mem("b", "2", at(8))],
      [MERGE, MERGE],
    );
    await push(w2.env, "from", [mut("keys", "clear", at(5))], [MERGE], {
      clientId: C2,
      deviceId: "d2",
    });
    await merge(w2.env, "from", "to");
    expect((await dump(w2.env, "to"))!.keys!.value).toEqual({ b: "2" });
  });

  it("max and min keep the better value, whatever the clock, when the caller knows the policy", () => {
    const row = (value: number, h: string): StoredSetting => ({
      key: "score",
      scope: "user",
      version: 1,
      stamp: { hlc: at(+h), clientId: C1 },
      deleted: false,
      value,
    });
    expect(joinRows(row(10, "9"), row(50, "1"), "max").value).toBe(50);
    expect(joinRows(row(50, "1"), row(10, "9"), "max").value).toBe(50);
    expect(joinRows(row(10, "9"), row(50, "1"), "min").value).toBe(10);
    // Without a policy it is lastWrite.
    expect(joinRows(row(10, "9"), row(50, "1")).value).toBe(10);
  });

  it("the policy table reaches the object over the wire and is validated", async () => {
    const { env } = world();
    await setOne(env, "to", "score", 10, at(9));
    await setOne(env, "from", "score", 50, at(1), C2, "d2");
    const doc = (await exportCloudSync(env, { product: P, subject: "from" }))!;
    await absorbCloudSync(env, { product: P, subject: "to" }, doc, [
      ["score", "max"],
    ]);
    expect((await dump(env, "to"))!.score!.value).toBe(50);
    await expect(
      absorbCloudSync(env, { product: P, subject: "to" }, doc, [
        ["score", "nonsense" as never],
      ]),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("client bindings are adopted, and the higher last mutation id is kept", async () => {
    const { env } = world();
    await setOne(env, "to", "a", 1, at(1));
    await push(
      env,
      "from",
      [
        mut("b", "set", at(2), { value: 1 }),
        mut("c", "set", at(3), { value: 1 }),
      ],
      [LAST, LAST],
      { clientId: C2, deviceId: "d2" },
    );
    await merge(env, "from", "to");
    const d = (await exportCloudSync(env, { product: P, subject: "to" }))!;
    expect(d.clients.map((c) => [c.clientId, c.deviceId]).sort()).toEqual([
      [C1, "d1"],
      [C2, "d2"],
    ]);
    // The device of the absorbed person now pushes to the survivor and does not replay its journal.
    const again = await push(
      env,
      "to",
      [mut("b", "set", at(2), { value: 1 })],
      [LAST],
      {
        clientId: C2,
        deviceId: "d2",
      },
    );
    expect(again.ok).toBe(true);
  });

  it("a pull from the survivor sees the absorbed rows after any earlier cursor", async () => {
    const { env } = world();
    await setOne(env, "to", "a", 1, at(1));
    const before = (
      await callCloudSync<"usage">(
        env,
        { product: P, subject: "to" },
        { op: "usage" },
      )
    ).seq;
    await setOne(env, "from", "b", 2, at(2), C2, "d2");
    await merge(env, "from", "to");
    const pulled = await callCloudSync<"pull">(
      env,
      { product: P, subject: "to" },
      {
        op: "pull",
        cursor: before,
        deviceId: "d1",
        family: "desktop",
        clientId: C1,
      },
    );
    expect(
      pulled.outcome.ok &&
        pulled.outcome.changes.map((c) => (c as { setting: string }).setting),
    ).toEqual(["b"]);
  });
});

describe("absorb: L8, keep everything and refuse later growth", () => {
  it("a merge over the settings budget keeps every row; growth is refused, a clear is not", async () => {
    const { env } = world();
    const many = (n: number, p: string) =>
      Array.from({ length: n }, (_, i) =>
        mut(`${p}${i}`, "set", at(1), { value: "v" }),
      );
    for (const [subject, prefix, client] of [
      ["to", "a", C1],
      ["from", "b", C2],
    ] as const) {
      // 100 mutations is the batch limit: two pushes.
      for (const half of [0, 100]) {
        const batch = many(100, `${prefix}${half}-`);
        const r = await push(
          env,
          subject,
          batch,
          batch.map(() => LAST),
          { clientId: client, deviceId: client === C1 ? "d1" : "d2" },
        );
        expect(r.ok && r.results.every((x) => x.status === "ok")).toBe(true);
      }
    }
    await merge(env, "from", "to");
    const u = await callCloudSync<"usage">(
      env,
      { product: P, subject: "to" },
      { op: "usage" },
    );
    expect(u.usage.settings).toBe(400);
    const grow = await setOne(env, "to", "new", 1, at(9));
    expect(grow.ok && grow.results[0]).toMatchObject({
      status: "rejected",
      code: "quota_exceeded",
    });
    const shrink = await push(
      env,
      "to",
      [mut("a0-0", "clear", at(10))],
      [LAST],
    );
    expect(shrink.ok && shrink.results[0]?.status).toBe("ok");
  });

  it("a quota below the absorbed total changes nothing at merge time; only later growth is refused", async () => {
    const { env } = world();
    await setOne(env, "to", "a", "x".repeat(100), at(1));
    await setOne(env, "from", "b", "y".repeat(100), at(1), C2, "d2");
    await merge(env, "from", "to");
    const total = (
      await callCloudSync<"usage">(
        env,
        { product: P, subject: "to" },
        { op: "usage" },
      )
    ).usage.bytes;
    expect(total).toBeGreaterThan(200);
    const refused = await push(
      env,
      "to",
      [mut("c", "set", at(5), { value: 1 })],
      [LAST],
      {
        limits: { quotaBytes: 150 },
      },
    );
    expect(refused.ok && refused.results[0]).toMatchObject({
      code: "quota_exceeded",
    });
    expect(await dump(env, "to")).toMatchObject({ a: {}, b: {} });
  });
});

describe("absorb: idempotence and retry-safety", () => {
  it("absorbing the same export twice writes nothing the second time", async () => {
    const { env } = world();
    await setOne(env, "to", "a", 1, at(1));
    await setOne(env, "from", "b", 2, at(2), C2, "d2");
    const doc = (await exportCloudSync(env, { product: P, subject: "from" }))!;
    const to = { product: P, subject: "to" };
    expect((await absorbCloudSync(env, to, doc)).changed).toBeGreaterThan(0);
    const seq = (await callCloudSync<"usage">(env, to, { op: "usage" })).seq;
    expect((await absorbCloudSync(env, to, doc)).changed).toBe(0);
    expect((await callCloudSync<"usage">(env, to, { op: "usage" })).seq).toBe(
      seq,
    );
  });

  it("the join is order-independent: A into B equals B into A", () => {
    const a = new MemoryStore();
    const b = new MemoryStore();
    const rows = (hlc: string, v: string, client: string): StoredSetting[] => [
      {
        key: "k",
        scope: "user",
        version: 1,
        stamp: { hlc, clientId: client },
        deleted: false,
        value: v,
      },
    ];
    const x = rows(at(1), "x", C1);
    const y = rows(at(2), "y", C2);
    absorbSettings(a, { settings: x, clients: [] });
    absorbSettings(a, { settings: y, clients: [] });
    absorbSettings(b, { settings: y, clients: [] });
    absorbSettings(b, { settings: x, clients: [] });
    expect(a.getSetting("k", "user")?.value).toBe(
      b.getSetting("k", "user")?.value,
    );
    expect(a.getSetting("k", "user")?.stamp).toEqual(
      b.getSetting("k", "user")?.stamp,
    );
  });

  // A namespace that fails the Nth call, before or after the object ran it: a crash on either side
  // of the commit. Every call a merge makes goes through it.
  function flaky(
    ns: CloudSyncNamespaceMock,
    failAt: number,
    when: "before" | "after",
  ) {
    let n = 0;
    return {
      idFromName: (name: string) => ns.idFromName(name),
      get: (id: DurableObjectId) => {
        const real = asCloudSyncNamespace(ns).get(id) as unknown as {
          fetch: (u: string, i?: RequestInit) => Promise<Response>;
        };
        return {
          fetch: async (u: string, i?: RequestInit) => {
            n++;
            if (n === failAt && when === "before")
              throw new Error("crash before");
            const res = await real.fetch(u, i);
            if (n === failAt && when === "after")
              throw new Error("crash after");
            return res;
          },
        };
      },
    } as unknown as DurableObjectNamespace;
  }

  async function seeded() {
    const w = world();
    await setOne(w.env, "to", "a", "survivor", at(1));
    await setOne(w.env, "to", "shared", "old", at(2));
    await setOne(w.env, "from", "shared", "new", at(6), C2, "d2");
    await push(
      w.env,
      "from",
      [
        mut("keys", "setMember", at(3), { member: "jump", value: "w" }),
        mut("b", "set", at(4), { value: 2 }),
      ],
      [MERGE, LAST],
      { clientId: C2, deviceId: "d2" },
    );
    await push(w.env, "from", [mut("b", "clear", at(7))], [LAST], {
      clientId: C2,
      deviceId: "d2",
    });
    return w;
  }

  const rowsOf = async (env: Cs, subject: string) => {
    const d = (await exportCloudSync(env, { product: P, subject }))!;
    return d.settings.map((r) => ({ ...r, version: 0 }));
  };

  it("a crash at any call, before or after it ran, then a retry, ends where an uninterrupted merge ends and loses nothing in between", async () => {
    const ref = await seeded();
    await merge(ref.env, "from", "to");
    const want = await rowsOf(ref.env, "to");
    expect(await dump(ref.env, "from")).toBeNull();
    let sawCrash = 0;
    for (const when of ["before", "after"] as const) {
      for (let failAt = 1; failAt <= 3; failAt++) {
        const w = await seeded();
        const sources = { CLOUD_SYNC: flaky(w.ns, failAt, when) };
        const db = makeTestDb();
        let crashed = false;
        try {
          await runSubjectMerge(
            { db, env: sources as never, now: 1 },
            { product: P, from: "from", to: "to" },
          );
        } catch {
          crashed = true;
        }
        if (crashed) {
          sawCrash++;
          // Between the crash and the retry every key is in the absorbed or the survivor's object.
          const have = {
            ...((await dump(w.env, "from")) ?? {}),
            ...((await dump(w.env, "to")) ?? {}),
          };
          for (const k of ["a", "shared", "keys", "b"])
            expect(have[k], k).toBeDefined();
        }
        // The retry (the caller runs the same hook again) runs on the healthy namespace.
        await runSubjectMerge(
          { db, env: w.env as never, now: 1 },
          { product: P, from: "from", to: "to" },
        );
        expect(await rowsOf(w.env, "to"), `${when} ${failAt}`).toEqual(want);
        expect(await dump(w.env, "from")).toBeNull();
      }
    }
    expect(sawCrash).toBeGreaterThanOrEqual(5);
  });

  it("the directory half is retry-safe too: a crash after the object moved, then a retry, adds the counters once", async () => {
    const w = world();
    const db = makeTestDb();
    const put = (subject: string, bytes: number) =>
      db.run(
        `INSERT INTO sync_directory (product, subject, bytes, settings, records, files, revision_bytes,
           quota_bytes, tier_id, platform, last_active_at, updated_at)
         VALUES (?, ?, ?, 1, 0, 0, 0, 0, NULL, NULL, 1, 1)`,
        P,
        subject,
        bytes,
      );
    await put("from", 10);
    await put("to", 5);
    await setOne(w.env, "from", "a", 1, at(1), C2, "d2");
    const ctx = (env: unknown) => ({ db, env: env as never, now: 1 });
    // The batch is the last step: make the DB fail once by wrapping it.
    let failBatch = true;
    const flakyDb = new Proxy(db, {
      get(t, p, r) {
        if (p === "batch")
          return async (...a: unknown[]) => {
            if (failBatch) {
              failBatch = false;
              throw new Error("d1 down");
            }
            return (t as any).batch(...a);
          };
        return Reflect.get(t, p, r);
      },
    });
    await expect(
      runSubjectMerge(
        { db: flakyDb as never, env: w.env as never, now: 1 },
        { product: P, from: "from", to: "to" },
      ),
    ).rejects.toThrow("d1 down");
    await runSubjectMerge(ctx(w.env), { product: P, from: "from", to: "to" });
    await runSubjectMerge(ctx(w.env), { product: P, from: "from", to: "to" });
    expect(
      await db.all<any>("SELECT subject, bytes FROM sync_directory"),
    ).toEqual([{ subject: "to", bytes: 15 }]);
  });

  it("a write that lands on the absorbed object mid-merge is not lost: the merge absorbs again", async () => {
    const w = world();
    await setOne(w.env, "from", "early", 1, at(1), C2, "d2");
    let injected = false;
    const real = asCloudSyncNamespace(w.ns);
    const racing = {
      idFromName: (n: string) => real.idFromName(n),
      get: (id: DurableObjectId) => {
        const stub = real.get(id) as unknown as {
          fetch: (u: string, i?: RequestInit) => Promise<Response>;
        };
        return {
          fetch: async (u: string, i?: RequestInit) => {
            const body = JSON.parse(String(i?.body)) as {
              op: string;
              subject: string;
            };
            const res = await stub.fetch(u, i);
            // Right after the first absorb, a device still on the old subject pushes.
            if (body.op === "absorb" && !injected) {
              injected = true;
              await setOne(w.env, "from", "late", 2, at(5), C2, "d2");
            }
            return res;
          },
        };
      },
    } as unknown as DurableObjectNamespace;
    await runSubjectMerge(
      { db: makeTestDb(), env: { CLOUD_SYNC: racing } as never, now: 1 },
      { product: P, from: "from", to: "to" },
    );
    expect(await dump(w.env, "to")).toMatchObject({
      early: { value: 1 },
      late: { value: 2 },
    });
    expect(await dump(w.env, "from")).toBeNull();
  });

  it("an object that keeps changing is not deleted, and the merge fails to be retried", async () => {
    const w = world();
    await setOne(w.env, "from", "k", 0, at(1), C2, "d2");
    let n = 0;
    const real = asCloudSyncNamespace(w.ns);
    const busy = {
      idFromName: (x: string) => real.idFromName(x),
      get: (id: DurableObjectId) => {
        const stub = real.get(id) as unknown as {
          fetch: (u: string, i?: RequestInit) => Promise<Response>;
        };
        return {
          fetch: async (u: string, i?: RequestInit) => {
            const body = JSON.parse(String(i?.body)) as { op: string };
            const res = await stub.fetch(u, i);
            if (body.op === "absorb")
              await setOne(w.env, "from", "k", ++n, at(10 + n), C2, "d2");
            return res;
          },
        };
      },
    } as unknown as DurableObjectNamespace;
    await expect(
      runSubjectMerge(
        { db: makeTestDb(), env: { CLOUD_SYNC: busy } as never, now: 1 },
        { product: P, from: "from", to: "to" },
      ),
    ).rejects.toThrow(/kept changing/);
    expect(await dump(w.env, "from")).not.toBeNull();
  });
});

describe("absorb: isolation", () => {
  it("a merge of a subject into itself does nothing", async () => {
    const { ns, env } = world();
    await setOne(env, "a", "k", 1, at(1));
    const calls = ns.calls.length;
    await merge(env, "a", "a");
    expect(ns.calls.length).toBe(calls);
    expect(await dump(env, "a")).toMatchObject({ k: { value: 1 } });
  });

  it("the object refuses a document of another product, of itself, or malformed, and writes nothing", async () => {
    const { ns, env } = world();
    await setOne(env, "to", "k", 1, at(1));
    await setOne(env, "from", "k", 2, at(5), C2, "d2");
    const doc = (await exportCloudSync(env, { product: P, subject: "from" }))!;
    const to = { product: P, subject: "to" };
    const bad: ExportDocument[] = [
      { ...doc, product: "other" },
      { ...doc, subject: "to" },
      { ...doc, settings: [{ ...doc.settings[0]!, key: "bad key" }] },
      {
        ...doc,
        settings: [{ ...doc.settings[0]!, stamp: { hlc: "x", clientId: C1 } }],
      },
      {
        ...doc,
        clients: [{ clientId: "nope", deviceId: "d", lastMutationId: 1 }],
      },
      { ...doc, settings: "nope" as never },
    ];
    const before = ns.instance(`${P}:to`).storage.sql.rowsWritten;
    for (const d of bad)
      await expect(absorbCloudSync(env, to, d)).rejects.toMatchObject({
        status: 400,
      });
    expect(ns.instance(`${P}:to`).storage.sql.rowsWritten).toBe(before);
    expect(await dump(env, "to")).toMatchObject({ k: { value: 1 } });
  });

  it("an absorb into an object pinned to another pair is a 403", async () => {
    const { ns, env } = world();
    await setOne(env, "from", "k", 1, at(1), C2, "d2");
    await setOne(env, "to", "k", 1, at(1));
    const doc = (await exportCloudSync(env, { product: P, subject: "from" }))!;
    const stub = asCloudSyncNamespace(ns).get(ns.idFromName(`${P}:to`));
    const r = await stub.fetch("https://do/", {
      method: "POST",
      body: JSON.stringify({
        op: "absorb",
        product: P,
        subject: "mallory",
        document: doc,
      }),
    });
    expect(r.status).toBe(403);
  });

  it("only the subject store's merge hook absorbs, and only it and product deletion name the client", () => {
    const root = join(TEST_ROOT, "..", "src");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk(root);
    const users = (re: RegExp) =>
      files
        .filter((f) => re.test(readFileSync(f, "utf8")))
        .map((f) => relative(root, f))
        .sort();
    expect(users(/\babsorbCloudSync\(/)).toEqual([
      "services/sync/do/client.ts",
      "services/sync/subjectStore.ts",
    ]);
    // U-05.12, U-05.13: the device routes (the pull and the push) call the object too, and
    // `handlers/common.ts` maps its refusals. `absorbCloudSync` above stays the merge hook's alone.
    // U-11a.1: the console's Data tab summary reads the object (`inspect`, read-only).
    // (Scoped to Sync's own files: Cloud Connect has a `do/client.js` of its own.)
    expect(
      users(/do\/client\.js"/).filter((f) => f.startsWith("services/sync/")),
    ).toEqual([
      "services/sync/admin/subject.ts",
      "services/sync/handlers/common.ts",
      "services/sync/handlers/fileFinalize.ts",
      "services/sync/handlers/fileUpload.ts",
      "services/sync/handlers/files.ts",
      "services/sync/handlers/pull.ts",
      "services/sync/handlers/push.ts",
      "services/sync/productDeletion.ts",
      "services/sync/subjectStore.ts",
    ]);
    expect(
      users(/\bCLOUD_SYNC\b/).filter((f) => !f.startsWith("services/sync/")),
    ).toEqual(["platform/env.ts", "platformInventory.generated.ts"]);
  });
});

describe("absorb: the real account merge", () => {
  const setup = async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), []);
    await seedProduct(db, P);
    const account = async (email: string) => {
      const r = await signIn(
        db,
        { issuerKey: "email", subject: email, kind: "email" },
        NOW,
        { unfenced: true, product: { slug: P } },
      );
      if (r.status !== "signed_in") throw new Error(r.status);
      return { id: r.account.id, subject: r.subject! };
    };
    const ada = await account("ada@example.com");
    const bo = await account("bo@example.com");
    expect(ada.subject).not.toBe(bo.subject);
    const run = async () =>
      mergeAccounts(
        { db, env, now: NOW, origin: "https://key.plrs.im" },
        {
          survivor: { accountId: ada.id, authenticatedAt: NOW },
          absorbed: { accountId: bo.id, authenticatedAt: NOW },
        },
      );
    return { cs: env as unknown as Cs, ada, bo, run };
  };

  it("an account merge moves the absorbed account's synced settings to the survivor's subject", async () => {
    const { cs, ada, bo, run } = await setup();
    await setOne(cs, ada.subject, "theme", "dark", at(1));
    await setOne(cs, bo.subject, "lang", "fr", at(2), C2, "d2");
    expect((await run()).ok).toBe(true);
    expect(await dump(cs, ada.subject)).toMatchObject({
      theme: { value: "dark" },
      lang: { value: "fr" },
    });
    expect(await dump(cs, bo.subject)).toBeNull();
  });

  it("an account merge moves records, and parks the absorbed copy of a colliding revision record (U-09.8)", async () => {
    const { cs, ada, bo, run } = await setup();
    const REV: Classification = {
      verdict: "record",
      policy: "revision",
      maxRecords: 10,
    };
    const rec = (id: string, value: number, n: number): SyncMutation => ({
      mutationId: nextId++,
      target: { record: ["saves", id] },
      op: "set",
      editedHlc: at(n),
      value,
    });
    await push(cs, ada.subject, [rec("a", 1, 1)], [REV]);
    await push(cs, bo.subject, [rec("a", 2, 2), rec("b", 3, 3)], [REV, REV], {
      clientId: C2,
      deviceId: "d2",
    });
    expect((await run()).ok).toBe(true);
    const doc = (await exportCloudSync(cs, {
      product: P,
      subject: ada.subject,
    }))!;
    expect(doc.records?.map((r) => [r.id, r.value])).toEqual([
      ["a", 1],
      ["b", 3],
    ]);
    expect(doc.parked).toEqual([
      expect.objectContaining({ id: "a", value: 2, fromSubject: bo.subject }),
    ]);
    expect(
      await exportCloudSync(cs, { product: P, subject: bo.subject }),
    ).toBeNull();
  });
});
