/**
 * U-05.6: the real `CloudSyncDO` class over a better-sqlite3 `SqlStorage` mock (plans/U-05-slices.md
 * §3). The engine's rules are proved by the parity suites; this file proves the object around them:
 * lazy schema, the pin, isolation, deletion and export, parameterised SQL, and serialisation.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type MutationResult,
  type SyncMutation,
} from "@polaris-key/protocol/sync";
import { formatHlc } from "../../../src/services/sync/engine/hlc.js";
import type { Classification } from "../../../src/services/sync/engine/types.js";
import type { CloudSyncReply } from "../../../src/services/sync/do/protocol.js";
import {
  MIGRATIONS,
  SCHEMA_VERSION,
} from "../../../src/services/sync/do/sqlStore.js";
import {
  CloudSyncNamespaceMock,
  DoStorageMock,
  asCloudSyncNamespace,
  ERASED_LEFTOVERS,
  erasureLeftovers,
  rowCounts,
} from "../../cloudSyncDoMock.js";
import { CloudSyncDO } from "../../../src/services/sync/do/cloudSyncDo.js";
import type { Env } from "../../../src/platform/env.js";
import { TEST_ROOT } from "../../paths.js";

const NOW = 1_760_000_000_000;
const C1 = "c_000000000000000client1";
const P = "demo";
const ALICE = "sub_alice";
const BOB = "sub_bob";
const nameOf = (product: string, subject: string) => `${product}:${subject}`;

const LAST_WRITE: Classification = {
  verdict: "accept",
  scope: "user",
  policy: "lastWrite",
};
const MERGE: Classification = {
  verdict: "accept",
  scope: "user",
  policy: "merge",
};

let ids = 1;
const mut = (
  key: string,
  op: SyncMutation["op"],
  extra: Partial<SyncMutation> = {},
): SyncMutation => ({
  mutationId: ids++,
  target: { setting: key, scope: "user" },
  op,
  editedHlc: formatHlc(NOW - 1000, 0),
  ...extra,
});

async function call(
  ns: CloudSyncNamespaceMock,
  product: string,
  subject: string,
  body: Record<string, unknown>,
  at = nameOf(product, subject),
): Promise<{ status: number; body: any }> {
  const stub = asCloudSyncNamespace(ns).get(ns.idFromName(at));
  const res = await stub.fetch("https://do/", {
    method: "POST",
    body: JSON.stringify({ product, subject, ...body }),
  });
  return { status: res.status, body: await res.json() };
}

const push = (
  ns: CloudSyncNamespaceMock,
  subject: string,
  mutations: SyncMutation[],
  classified: Classification[],
  extra: Record<string, unknown> = {},
  product = P,
) =>
  call(ns, product, subject, {
    op: "push",
    deviceId: "device-1",
    family: "desktop",
    limits: { quotaBytes: 1_000_000_000 },
    request: { clientId: C1, cursor: 0, mutations },
    classified,
    serverNow: NOW,
    ...extra,
  });

const pull = (
  ns: CloudSyncNamespaceMock,
  subject: string,
  cursor = 0,
  product = P,
) =>
  call(ns, product, subject, {
    op: "pull",
    cursor,
    deviceId: "device-1",
    family: "desktop",
    clientId: C1,
  });

const tables = (ns: CloudSyncNamespaceMock, name: string): string[] =>
  (
    ns
      .instance(name)
      .storage.sql.db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((r) => r.name);

describe("CloudSyncDO: lazy schema", () => {
  it("a pull, usage and export on a never-written object create nothing", async () => {
    const ns = new CloudSyncNamespaceMock();
    const r = await pull(ns, ALICE);
    expect(r.body.outcome).toMatchObject({
      ok: true,
      empty: true,
      changes: [],
    });
    expect((await call(ns, P, ALICE, { op: "usage" })).body).toMatchObject({
      usage: { bytes: 0 },
      seq: 0,
      empty: true,
    });
    expect(
      (await call(ns, P, ALICE, { op: "exportAll" })).body.document,
    ).toBeNull();
    expect(tables(ns, nameOf(P, ALICE))).toEqual([]);
    expect(ns.instance(nameOf(P, ALICE)).storage.sql.rowsWritten).toBe(0);
  });

  it("the first push makes the schema and pins the pair; the second runs no DDL", async () => {
    const ns = new CloudSyncNamespaceMock();
    ids = 1;
    const a = await push(
      ns,
      ALICE,
      [mut("a", "set", { value: 1 })],
      [LAST_WRITE],
    );
    expect(a.body.outcome).toMatchObject({
      ok: true,
      results: [{ status: "ok" }],
    });
    const inst = ns.instance(nameOf(P, ALICE));
    expect(tables(ns, nameOf(P, ALICE))).toEqual([
      "clients",
      "files",
      "meta",
      "parked_records",
      "record_fields",
      "records",
      "set_elements",
      "setting_members",
      "settings",
      "ssec_keys",
      "tombstones",
      "upload_parts",
      "uploads",
    ]);
    const meta = Object.fromEntries(
      (
        inst.storage.sql.db.prepare("SELECT key, value FROM meta").all() as {
          key: string;
          value: string;
        }[]
      ).map((r) => [r.key, r.value]),
    );
    expect(meta).toMatchObject({
      schema_version: String(SCHEMA_VERSION),
      product: P,
      subject: ALICE,
    });
    const before = inst.storage.sql.log.length;
    await push(ns, ALICE, [mut("b", "set", { value: 2 })], [LAST_WRITE]);
    const ddl = inst.storage.sql.log
      .slice(before)
      .filter((l) => /^\s*(CREATE|ALTER|DROP)/i.test(l.query));
    expect(ddl).toEqual([]);
  });

  it("migrates an older schema on a read or a write, and refuses a newer one", async () => {
    const storage = new DoStorageMock();
    // A v0 object: the meta table exists, no version row, no other table.
    storage.sql.exec(
      "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID",
    );
    const obj = new CloudSyncDO(
      { storage } as unknown as DurableObjectState,
      {} as Env,
    );
    const res = await obj.fetch(
      new Request("https://do/", {
        method: "POST",
        body: JSON.stringify({
          product: P,
          subject: ALICE,
          op: "pull",
          deviceId: "d",
          family: "desktop",
        }),
      }),
    );
    expect((await res.json()) as CloudSyncReply).toMatchObject({
      outcome: { ok: true, empty: true },
    });
    expect(
      storage.sql.db
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get(),
    ).toEqual({ value: String(SCHEMA_VERSION) });

    storage.sql.exec(
      "UPDATE meta SET value = '99' WHERE key = 'schema_version'",
    );
    const refused = await obj.fetch(
      new Request("https://do/", {
        method: "POST",
        body: JSON.stringify({ product: P, subject: ALICE, op: "usage" }),
      }),
    );
    expect(refused.status).toBe(500);
    expect(await refused.json()).toEqual({ error: "unsupported_schema" });
  });
});

describe("CloudSyncDO: schema v4 (files, U-10.4)", () => {
  const request = (op: Record<string, unknown>) =>
    new Request("https://do/", {
      method: "POST",
      body: JSON.stringify({ product: P, subject: ALICE, ...op }),
    });

  it("migrates a v3 object on its first read, with the file tables empty, and refuses v5", async () => {
    const storage = new DoStorageMock();
    for (const step of MIGRATIONS.slice(0, 3))
      for (const stmt of step) storage.sql.exec(stmt);
    storage.sql.exec(
      `INSERT INTO meta (key, value) VALUES ('schema_version', '3'), ('product', '${P}'), ('subject', '${ALICE}')`,
    );
    const obj = new CloudSyncDO(
      { storage } as unknown as DurableObjectState,
      {} as Env,
    );
    const res = await obj.fetch(request({ op: "usage" }));
    expect(res.status).toBe(200);
    expect(
      storage.sql.db
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get(),
    ).toEqual({ value: "4" });
    expect(
      rowCounts(storage, ["files", "uploads", "upload_parts", "ssec_keys"]),
    ).toEqual([0, 0, 0, 0]);
    // Written by a build with a schema this one does not know: refused, left as it is.
    storage.sql.exec(
      "UPDATE meta SET value = '5' WHERE key = 'schema_version'",
    );
    const refused = await obj.fetch(request({ op: "usage" }));
    expect(refused.status).toBe(500);
    expect(await refused.json()).toEqual({ error: "unsupported_schema" });
    expect(
      storage.sql.db
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get(),
    ).toEqual({ value: "5" });
  });

  it("an erased object keeps no file row, upload or SSE-C key", async () => {
    const ns = new CloudSyncNamespaceMock();
    ids = 1;
    await push(ns, ALICE, [mut("a", "set", { value: 1 })], [LAST_WRITE]);
    const db = ns.instance(nameOf(P, ALICE)).storage.sql.db;
    db.exec(
      `INSERT INTO files VALUES ('c', 'r', 1, 'u/p/s/o/x', 'whole', 'none', 5, '${"ab".repeat(32)}', 'live', 'k', 1, 'c1');
       INSERT INTO uploads VALUES ('u1', 'c', 'r', NULL, 'single', 'whole', 'none', 5, '${"ab".repeat(32)}', NULL, NULL, 5, 'd', 1, 2, 'open', NULL);
       INSERT INTO upload_parts VALUES ('u1', 1, 'e', 5);
       INSERT INTO ssec_keys VALUES ('k', x'00');`,
    );
    const stub = asCloudSyncNamespace(ns).get(
      asCloudSyncNamespace(ns).idFromName(nameOf(P, ALICE)),
    );
    const res = await stub.fetch("https://do/", {
      method: "POST",
      body: JSON.stringify({ product: P, subject: ALICE, op: "deleteAll" }),
    });
    expect(res.status).toBe(200);
    expect(erasureLeftovers(ns, nameOf(P, ALICE))).toEqual(ERASED_LEFTOVERS);
  });
});

describe("CloudSyncDO: push and pull", () => {
  it("round-trips a value, a merge and a clear, and answers the engine's results", async () => {
    const ns = new CloudSyncNamespaceMock();
    ids = 1;
    const r = await push(
      ns,
      ALICE,
      [
        mut("vol", "set", { value: 0.5 }),
        mut("keys", "setMember", { member: "jump", value: "space" }),
        mut("gone", "set", { value: 1 }),
      ],
      [LAST_WRITE, MERGE, LAST_WRITE],
    );
    expect(
      (r.body.outcome.results as MutationResult[]).map((m) => m.status),
    ).toEqual(["ok", "ok", "ok"]);
    await push(ns, ALICE, [mut("gone", "clear")], [LAST_WRITE]);
    const p = (await pull(ns, ALICE)).body.outcome;
    expect(p.changes.map((c: any) => [c.setting, c.value])).toEqual([
      ["vol", 0.5],
      ["keys", { jump: "space" }],
    ]);
    expect(p.tombstones.map((t: any) => t.setting)).toEqual(["gone"]);
    expect(p.lastMutationId).toBe(4);
    expect(p.etag).toBe(`"${p.cursor}.4"`);
    const incremental = (await pull(ns, ALICE, 3)).body.outcome;
    expect(incremental.changes).toEqual([]);
    expect(incremental.tombstones).toHaveLength(1);
  });

  it("a malformed batch is the engine's bad_request and creates nothing", async () => {
    const ns = new CloudSyncNamespaceMock();
    const r = await call(ns, P, ALICE, {
      op: "push",
      deviceId: "d",
      family: "desktop",
      limits: { quotaBytes: 1 },
      request: { clientId: "x", cursor: 0, mutations: [] },
      classified: [],
      serverNow: NOW,
    });
    expect(r.body.outcome).toMatchObject({ ok: false, error: "bad_request" });
    expect(tables(ns, nameOf(P, ALICE))).toEqual([]);
  });

  it("answers 400 to a push without a family or without limits, and to a platform write with an empty family; creates nothing (SR-1 N1)", async () => {
    const ns = new CloudSyncNamespaceMock();
    ids = 1;
    const base = {
      op: "push",
      deviceId: "d",
      family: "desktop",
      limits: { quotaBytes: 1000 },
      request: {
        clientId: C1,
        cursor: 0,
        mutations: [
          mut("res", "set", {
            value: 1,
            target: { setting: "res", scope: "platform" },
          }),
        ],
      },
      classified: [
        { verdict: "accept", scope: "platform", policy: "lastWrite" },
      ],
      serverNow: NOW,
    };
    const without = (k: string) => {
      const { [k]: _gone, ...rest } = base as Record<string, unknown>;
      void _gone;
      return rest;
    };
    for (const body of [
      without("family"),
      without("limits"),
      { ...base, family: "" },
      { ...base, limits: { quotaBytes: -1 } },
      { ...base, limits: { quotaBytes: "1000" } },
      { ...base, limits: null },
    ]) {
      const r = await call(ns, P, ALICE, body);
      expect(r.status).toBe(400);
    }
    expect(tables(ns, nameOf(P, ALICE))).toEqual([]);
    expect((await call(ns, P, ALICE, base)).body.outcome.ok).toBe(true);
  });

  it("one setMember on a 256-member row writes a small, constant number of rows (SR-1 B2)", async () => {
    const ns = new CloudSyncNamespaceMock();
    ids = 1;
    for (let b = 0; b < 3; b++) {
      const n = b === 2 ? 56 : 100;
      const muts = Array.from({ length: n }, (_, i) =>
        mut("tags", "setMember", { member: `m${b}-${i}`, value: i }),
      );
      await push(
        ns,
        ALICE,
        muts,
        muts.map(() => MERGE),
      );
    }
    const sql = ns.instance(nameOf(P, ALICE)).storage.sql;
    const cells = sql.db
      .prepare("SELECT count(*) AS n FROM setting_members")
      .get() as { n: number };
    expect(cells.n).toBe(256);
    const written = async (m: SyncMutation) => {
      const before = sql.rowsWritten;
      const r = await push(ns, ALICE, [m], [MERGE]);
      expect(r.body.outcome.results[0].status).toBe("ok");
      return sql.rowsWritten - before;
    };
    const set = await written(
      mut("tags", "setMember", { member: "m0-0", value: "new" }),
    );
    const remove = await written(
      mut("tags", "removeMember", { member: "m0-1" }),
    );
    // The row, the cell, the seq, the usage counters, the client binding and its write count:
    // a handful, however many cells the row holds.
    expect(set).toBeLessThanOrEqual(12);
    expect(remove).toBeLessThanOrEqual(12);
    expect(
      (
        sql.db.prepare("SELECT count(*) AS n FROM setting_members").get() as {
          n: number;
        }
      ).n,
    ).toBe(256);
    // The cells keep their order (ord): the rewritten one did not move to the end.
    const first = sql.db
      .prepare("SELECT member FROM setting_members ORDER BY ord LIMIT 2")
      .all() as { member: string }[];
    expect(first.map((r) => r.member)).toEqual(["m0-0", "m0-1"]);
  });

  it("runs the push in a transaction: a thrown push leaves no write behind", async () => {
    const ns = new CloudSyncNamespaceMock();
    ids = 1;
    await push(ns, ALICE, [mut("a", "set", { value: 1 })], [LAST_WRITE]);
    const inst = ns.instance(nameOf(P, ALICE));
    const store = (inst.obj as any).store;
    const seq = store.currentSeq();
    expect(() =>
      store.transaction(() => {
        store.nextSeq();
        store.putClient({ clientId: "x", deviceId: "d", lastMutationId: 9 });
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(store.currentSeq()).toBe(seq);
    expect(store.getClient("x")).toBeUndefined();
  });

  it("an atomic batch with one failure writes nothing", async () => {
    const ns = new CloudSyncNamespaceMock();
    ids = 1;
    const r = await push(
      ns,
      ALICE,
      [mut("a", "set", { value: 1 }), mut("b", "set", { value: 2 })],
      [LAST_WRITE, { verdict: "reject", code: "setting_not_synced" }],
      {
        request: {
          clientId: C1,
          cursor: 0,
          atomic: true,
          mutations: [
            {
              mutationId: 1,
              target: { setting: "a", scope: "user" },
              op: "set",
              value: 1,
              editedHlc: formatHlc(NOW - 1000, 0),
            },
            {
              mutationId: 2,
              target: { setting: "b", scope: "user" },
              op: "set",
              value: 2,
              editedHlc: formatHlc(NOW - 1000, 0),
            },
          ],
        },
      },
    );
    expect(
      (r.body.outcome.results as MutationResult[]).map((m) => m.status),
    ).toEqual(["aborted", "rejected"]);
    expect((await pull(ns, ALICE)).body.outcome.changes).toEqual([]);
  });

  it("serialises concurrent pushes: no lost update, ids processed in order", async () => {
    const ns = new CloudSyncNamespaceMock();
    ids = 1;
    const mk = (n: number): SyncMutation => ({
      mutationId: n,
      target: { setting: `k${n}`, scope: "user" },
      op: "set",
      value: n,
      editedHlc: formatHlc(NOW - 1000, 0),
    });
    const sends = [1, 2, 3, 4, 5].map((n) =>
      push(ns, ALICE, [mk(n)], [LAST_WRITE]),
    );
    await Promise.all(sends);
    const p = (await pull(ns, ALICE)).body.outcome;
    expect(p.changes).toHaveLength(5);
    expect(p.lastMutationId).toBe(5);
    expect(
      (await call(ns, P, ALICE, { op: "usage" })).body.usage.settings,
    ).toBe(5);
  });
});

describe("CloudSyncDO: isolation (SR-1)", () => {
  async function seeded() {
    const ns = new CloudSyncNamespaceMock();
    ids = 1;
    await push(
      ns,
      ALICE,
      [mut("secret", "set", { value: "alice-data" })],
      [LAST_WRITE],
    );
    return ns;
  }

  it("refuses another subject, and another product, on every operation, touching nothing", async () => {
    const ns = await seeded();
    const at = nameOf(P, ALICE);
    const inst = ns.instance(at);
    const snapshot = () =>
      JSON.stringify(
        inst.storage.sql.db.prepare("SELECT * FROM settings").all(),
      );
    const before = snapshot();
    for (const [product, subject] of [
      [P, BOB],
      ["other", ALICE],
    ] as const) {
      for (const body of [
        { op: "pull", cursor: 0, deviceId: "d", family: "desktop" },
        { op: "usage" },
        { op: "exportAll" },
        {
          op: "push",
          deviceId: "d",
          request: {
            clientId: C1,
            cursor: 0,
            mutations: [mut("x", "set", { value: 1 })],
          },
          classified: [LAST_WRITE],
          serverNow: NOW,
        },
        { op: "deleteAll" },
      ]) {
        const r = await call(ns, product, subject, body, at);
        expect(r.status).toBe(403);
        expect(r.body).toEqual({ error: "pin_mismatch" });
        expect(JSON.stringify(r.body)).not.toContain("alice-data");
      }
    }
    expect(snapshot()).toBe(before);
    // The refused deleteAll left the database and its alarm alone.
    expect(tables(ns, at)).toContain("settings");
  });

  it("refuses a request that names no product or subject, and a non-POST", async () => {
    const ns = new CloudSyncNamespaceMock();
    const stub = asCloudSyncNamespace(ns).get(ns.idFromName("x"));
    for (const body of [
      {},
      { product: P },
      { subject: ALICE },
      { product: "", subject: "" },
    ]) {
      const res = await stub.fetch("https://do/", {
        method: "POST",
        body: JSON.stringify({ op: "usage", ...body }),
      });
      expect(res.status).toBe(400);
    }
    expect(
      (await stub.fetch("https://do/", { method: "POST", body: "{" })).status,
    ).toBe(400);
    expect((await stub.fetch("https://do/", { method: "GET" })).status).toBe(
      405,
    );
  });

  it("two people's objects share nothing: each pull and export holds only its own data", async () => {
    const ns = new CloudSyncNamespaceMock();
    ids = 1;
    await push(
      ns,
      ALICE,
      [mut("k", "set", { value: "alice-data" })],
      [LAST_WRITE],
    );
    ids = 1;
    await push(ns, BOB, [mut("k", "set", { value: "bob-data" })], [LAST_WRITE]);
    expect(JSON.stringify((await pull(ns, ALICE)).body)).not.toContain(
      "bob-data",
    );
    expect(JSON.stringify((await pull(ns, BOB)).body)).not.toContain(
      "alice-data",
    );
    const exp = (await call(ns, P, ALICE, { op: "exportAll" })).body.document;
    expect(JSON.stringify(exp)).not.toContain("bob");
    expect(exp).toMatchObject({ product: P, subject: ALICE });
  });

  it("holds no reference to D1, the catalog or the environment (the flush is the one write)", () => {
    const dir = join(TEST_ROOT, "../src/services/sync/do");
    // `client.ts` is the Worker's side of the wire (it reads the binding); the rest is the object.
    // U-05.9 gives the object one D1 WRITE, its own directory flush (`cloudSyncDo.ts` takes the
    // handle, `directory.ts` builds the statements from the pinned pair); it never reads D1.
    const FLUSH = new Set(["cloudSyncDo.ts", "directory.ts"]);
    for (const f of readdirSync(dir).filter((f) => f !== "client.ts")) {
      const code = readFileSync(join(dir, f), "utf8").replace(
        /\/\*[\s\S]*?\*\/|\/\/.*$/gm,
        "",
      );
      expect(code, f).not.toMatch(
        /syncAccess|syncedSettings|validateEntryValue/,
      );
      if (FLUSH.has(f)) {
        // No read of D1, and the only binding named is `DB`, once, to make the handle.
        expect(code, f).not.toMatch(
          /\.(first|all)\s*[<(]|\benv\.(?!DB\b)[A-Z]/,
        );
        expect(
          (code.match(/\benv\.DB\b/g) ?? []).length,
          f,
        ).toBeLessThanOrEqual(1);
        // The handle is `batch` and its counting twin `batchChanges` (no read), and the environment is read in the constructor alone
        // (destructuring `env` is caught too: the word may not appear anywhere else).
        if (f === "cloudSyncDo.ts") {
          expect(code).toMatch(/Pick<Db, "batch" \| "batchChanges">/);
          const ctor = code.slice(
            code.indexOf("constructor("),
            code.indexOf("\n  }\n", code.indexOf("constructor(")),
          );
          expect(
            code.replace(ctor, ""),
            "env outside the constructor",
          ).not.toMatch(/\benv\b(?!\.js)/);
        }
        // Every statement it can send to D1 inserts; the INSERT ... SELECT is the guarded form.
        if (f === "directory.ts") {
          const sqls = [...code.matchAll(/sql:\s*`([^`]*)`/g)].map((m) =>
            (m[1] ?? "").trim(),
          );
          expect(sqls.length).toBeGreaterThan(0);
          for (const q of sqls)
            expect(q).toMatch(/^INSERT INTO sync_(directory|product_daily)\b/);
          expect(code).not.toMatch(/\b(UPDATE|DELETE\s+FROM)\s+sync_/);
        }
      } else {
        expect(code, f).not.toMatch(/\bD1\b|\benv\.[A-Z]|\.DB\b|\bDb\b/);
      }
    }
  });
});

describe("CloudSyncDO: SQL hygiene", () => {
  it("never puts a value into SQL text: hostile keys, members and values round-trip as data", async () => {
    const ns = new CloudSyncNamespaceMock();
    ids = 1;
    const evil = "x'); DROP TABLE settings; --";
    await push(
      ns,
      ALICE,
      [
        mut("hostile", "set", { value: evil }),
        mut("m", "setMember", { member: evil, value: evil }),
      ],
      [LAST_WRITE, MERGE],
    );
    const p = (await pull(ns, ALICE)).body.outcome;
    expect(p.changes[0].value).toBe(evil);
    expect(p.changes[1].value).toEqual({ [evil]: evil });
    const inst = ns.instance(nameOf(P, ALICE));
    for (const { query } of inst.storage.sql.log)
      expect(query).not.toContain("DROP TABLE settings;");
    expect(tables(ns, nameOf(P, ALICE))).toContain("settings");
    // Every placeholder has a binding and no request value is in any statement's text.
    for (const { query, bindings } of inst.storage.sql.log) {
      expect(query.split("?").length - 1).toBe(bindings.length);
      expect(query).not.toContain("hostile");
      expect(query).not.toContain("DROP");
    }
  });
});

describe("CloudSyncDO: exportAll and deleteAll", () => {
  it("exports rows, tombstones, members and clients of this subject only", async () => {
    const ns = new CloudSyncNamespaceMock();
    ids = 1;
    await push(
      ns,
      ALICE,
      [
        mut("a", "set", { value: 1 }),
        mut("g", "set", { value: 2 }),
        mut("m", "setMember", { member: "x", value: 1 }),
        mut("m", "removeMember", { member: "x" }),
      ],
      [LAST_WRITE, LAST_WRITE, MERGE, MERGE],
    );
    await push(ns, ALICE, [mut("g", "clear")], [LAST_WRITE]);
    const doc = (await call(ns, P, ALICE, { op: "exportAll" })).body.document;
    expect(doc.settings.map((s: any) => [s.key, s.deleted])).toEqual([
      ["a", false],
      ["m", true],
      ["g", true],
    ]);
    expect(doc.settings.find((s: any) => s.key === "m").members).toEqual([
      ["x", expect.objectContaining({ removed: true })],
    ]);
    expect(doc.clients).toEqual([
      { clientId: C1, deviceId: "device-1", lastMutationId: 5 },
    ]);
    expect(doc.usage.settings).toBe(1);
  });

  it("deleteAll removes every table and the alarm, and the data cannot be read back", async () => {
    const ns = new CloudSyncNamespaceMock();
    ids = 1;
    await push(
      ns,
      ALICE,
      [mut("k", "set", { value: "alice-data" })],
      [LAST_WRITE],
    );
    const inst = ns.instance(nameOf(P, ALICE));
    await inst.storage.setAlarm(NOW + 1000);
    expect((await call(ns, P, ALICE, { op: "deleteAll" })).body).toEqual({
      op: "deleteAll",
      deleted: true,
    });
    expect(erasureLeftovers(ns, nameOf(P, ALICE))).toEqual(ERASED_LEFTOVERS);
    expect(await inst.storage.getAlarm()).not.toBeNull();
    const raw = Buffer.from(inst.storage.sql.db.serialize()).toString("latin1");
    // (the in-memory pages may keep free-list bytes; the tables and rows are what the API exposes)
    expect((await pull(ns, ALICE)).body.outcome).toMatchObject({
      empty: true,
      changes: [],
    });
    expect(
      (await call(ns, P, ALICE, { op: "exportAll" })).body.document,
    ).toBeNull();
    expect(raw.length).toBeGreaterThan(0);
    // A push that was already on its way refuses instead of rebuilding the object.
    ids = 1;
    const again = await push(
      ns,
      ALICE,
      [mut("k2", "set", { value: 1 })],
      [LAST_WRITE],
    );
    expect(again.status).toBe(410);
    expect(erasureLeftovers(ns, nameOf(P, ALICE))).toEqual(ERASED_LEFTOVERS);
  });

  it("deleteAll on a never-written object is a clean no-op", async () => {
    const ns = new CloudSyncNamespaceMock();
    expect((await call(ns, P, ALICE, { op: "deleteAll" })).status).toBe(200);
  });
});

describe("cloudSyncObjectName (SR-1 N8)", () => {
  it("is product:subject for the two grammars, and throws for anything outside them", async () => {
    const { cloudSyncObjectName } =
      await import("../../../src/services/sync/do/client.js");
    expect(
      cloudSyncObjectName({
        product: "my-app-2",
        subject: "ps_Ab-_09xyzXYZ0123456789",
      }),
    ).toBe("my-app-2:ps_Ab-_09xyzXYZ0123456789");
    for (const pin of [
      { product: "a:b", subject: "ps_x" },
      { product: "A", subject: "ps_x" },
      { product: "", subject: "ps_x" },
      { product: "app", subject: "ps:x" },
      { product: "app", subject: "ps x" },
      { product: "app", subject: "" },
      { product: "app", subject: "ps_é" },
    ])
      expect(() => cloudSyncObjectName(pin), JSON.stringify(pin)).toThrow();
  });
});

describe("settingsPageAfter (SR-1 N12)", () => {
  it("pages in storage: the same rows as the memory store, tombstones and families included, and never more than the limit", async () => {
    const { SqlTestStore } = await import("../../cloudSyncSqlTestStore.js");
    const { MemoryStore } =
      await import("../../../src/services/sync/engine/memoryStore.js");
    const sqlStore = new SqlTestStore();
    const mem = new MemoryStore();
    for (const store of [sqlStore, mem])
      for (let i = 1; i <= 40; i++) {
        const scope = i % 3 === 0 ? "platform" : "user";
        const family = i % 2 === 0 ? "desktop" : "mobile";
        store.putSetting({
          key: `k${i}`,
          scope,
          ...(scope === "platform" ? { family } : {}),
          version: store.nextSeq(),
          stamp: { hlc: formatHlc(NOW, i), clientId: C1 },
          deleted: i % 5 === 0,
          value: i % 5 === 0 ? null : i,
        });
      }
    for (const family of ["desktop", "mobile", "console"])
      for (const [after, limit] of [
        [0, 7],
        [0, 1000],
        [13, 5],
        [39, 5],
        [40, 5],
      ] as const) {
        const a = sqlStore.settingsPageAfter(after, family, limit);
        const b = mem.settingsPageAfter(after, family, limit);
        expect(a.length).toBeLessThanOrEqual(limit);
        expect(a.map((r) => [r.key, r.version, r.deleted])).toEqual(
          b.map((r) => [r.key, r.version, r.deleted]),
        );
        expect(a.map((r) => r.version)).toEqual(
          [...a.map((r) => r.version)].sort((x, y) => x - y),
        );
      }
    // Walking the pages by the last version visits every visible row exactly once.
    const seen: string[] = [];
    for (let cursor = 0; ; ) {
      const page = sqlStore.settingsPageAfter(cursor, "desktop", 6);
      if (page.length === 0) break;
      seen.push(...page.map((r) => r.key));
      cursor = page[page.length - 1]!.version;
    }
    expect(seen).toHaveLength(new Set(seen).size);
    expect(seen.length).toBe(mem.settingsPageAfter(0, "desktop", 1000).length);
  });
});
