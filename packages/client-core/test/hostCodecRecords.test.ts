// The record half of the host codec (U-22.0; WIRE-CONTRACT-V5 §13.10.4, "Record names"): what
// `sealPush` sends for a record value, field or element, and what `openPull` proves before a
// sealed record row reaches the machine. The corpus rows (`envelopeCases`, appended by U-09.2b)
// run through `openPull` here, as the Node runner runs them through `openValueAnyName`.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CloudSyncMachine,
  type CloudSyncOptions,
  type Json,
  type OpenedBody,
  type SyncRequest,
  type WireMutation,
} from "../src/cloud-sync.js";
import {
  blind,
  canonicalJson,
  elementEnvelopeName,
  fieldEnvelopeName,
  isBlindedName,
  openPull,
  openValue,
  recordRef,
  sealPush,
  sealValue,
  webCryptoSyncPort as port,
  type HostCodec,
  type SyncJson,
} from "../src/sync/index.js";
import { openValueAnyName } from "../src/sync/index.js";

const root = Uint8Array.from({ length: 32 }, (_, i) => 3 * i + 7);
const otherRoot = Uint8Array.from({ length: 32 }, (_, i) => 250 - 5 * i);
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));

function codecOf(r: Uint8Array): HostCodec {
  return {
    locked: false,
    seal: (c, n, v) => sealValue(port, r, c, n, v),
    open: (c, n, e, a) => openValue(port, r, c, n, e, a),
    openAny: (c, e) => openValueAnyName(port, r, c, e),
    blind: (k, ctx, n) => blind(port, r, k, ctx, n),
  };
}
const codec = codecOf(root);
const bl = (kind: Parameters<HostCodec["blind"]>[0], ctx: string, n: string) =>
  blind(port, root, kind, ctx, n);
const seal = async (c: string, name: string, v: SyncJson, r = root) =>
  b64(await sealValue(port, r, c, name, v));

const push = (mutations: Json[]): Json => ({
  clientId: "c_x",
  cursor: 0,
  atomic: false,
  mutations,
});
const rec = (
  mutationId: number,
  id: string,
  op: string,
  rest: Record<string, Json> = {},
  collection = "saves",
): Json => ({ mutationId, target: { record: [collection, id] }, op, ...rest });
const sealOne = async (m: Json): Promise<any> =>
  ((await sealPush(push([m]), codec, [])) as any).mutations[0];
const refused = (m: Json): Promise<unknown> =>
  expect(sealPush(push([m]), codec, [])).rejects.toMatchObject({
    code: "invalid-options",
  });

describe("sealPush: records", () => {
  it("seals a value under k = id, blinds the id and leaves the collection in the clear", async () => {
    const m = await sealOne(
      rec(1, "slot-1", "set", { value: { hp: 10 }, baseVersion: "*" }),
    );
    expect(m.target).toEqual({
      record: ["saves", await bl("record", "saves", "slot-1")],
    });
    expect("value" in m).toBe(false);
    expect(m.baseVersion).toBe("*");
    expect(await openValue(port, root, "saves", "slot-1", unb64(m.ct))).toEqual(
      { ok: true, name: "slot-1", value: { hp: 10 } },
    );
    expect(JSON.stringify(m)).not.toContain("slot-1");
  });

  it("delete carries the blinded id and nothing sealed", async () => {
    const m = await sealOne(rec(2, "slot-1", "delete", { baseVersion: 3 }));
    expect(m.target.record[1]).toBe(await bl("record", "saves", "slot-1"));
    expect("ct" in m).toBe(false);
    expect(m.baseVersion).toBe(3);
  });

  it("setField seals under id U+0000 field and blinds both names", async () => {
    const m = await sealOne(
      rec(3, "slot-1", "setField", {
        field: "hp",
        value: 10,
        editedHlc: "0190f3a2c1b4:0003",
      }),
    );
    expect(m.field).toBe(await bl("field", "saves", "hp"));
    expect(m.target.record[1]).toBe(await bl("record", "saves", "slot-1"));
    expect(
      await openValue(
        port,
        root,
        "saves",
        fieldEnvelopeName("slot-1", "hp"),
        unb64(m.ct),
      ),
    ).toEqual({ ok: true, name: "slot-1\u0000hp", value: 10 });
    expect(m.editedHlc).toBe("0190f3a2c1b4:0003");
  });

  it("removeField sends the blinded field and no ct", async () => {
    const m = await sealOne(rec(4, "slot-1", "removeField", { field: "hp" }));
    expect(m.field).toBe(await bl("field", "saves", "hp"));
    expect("ct" in m).toBe(false);
  });

  it("add seals the element under id U+0000 canonicalJson(e); remove keeps observedSeq", async () => {
    const e = { tag: "a", id: 7 };
    const canon = '{"id":7,"tag":"a"}';
    const add = await sealOne(rec(5, "slot-1", "add", { element: e }));
    expect(add.element).toBe(await bl("element", "saves", canon));
    expect(
      await openValue(
        port,
        root,
        "saves",
        elementEnvelopeName("slot-1", canon),
        unb64(add.ct),
      ),
    ).toEqual({ ok: true, name: `slot-1\u0000${canon}`, value: e });
    const rm = await sealOne(
      rec(6, "slot-1", "remove", { element: e, observedSeq: 9 }),
    );
    expect(rm.element).toBe(add.element);
    expect(rm.observedSeq).toBe(9);
    expect("ct" in rm).toBe(false);
  });

  it("does not change the body it was given", async () => {
    const body = push([rec(1, "slot-1", "set", { value: 1 })]);
    const before = JSON.stringify(body);
    await sealPush(body, codec, []);
    expect(JSON.stringify(body)).toBe(before);
  });

  it("refuses, and so sends nothing, for a malformed reference", async () => {
    for (const bad of [
      [],
      ["saves"],
      ["saves", ""],
      ["", "a"],
      ["saves", "a\u0000b"],
      ["sa\u0000ves", "a"],
      ["$settings", "a"],
      ["$x", "a"],
      ["saves", 7],
      "saves/a",
    ] as Json[]) {
      await refused({
        mutationId: 1,
        target: { record: bad },
        op: "set",
        value: 1,
      });
    }
  });

  it("refuses a member an operation does not take, and a missing one", async () => {
    await refused(rec(1, "a", "set", {}));
    await refused(rec(1, "a", "set", { value: 1, ct: "AQ" }));
    await refused(rec(1, "a", "set", { value: 1, field: "f" }));
    await refused(rec(1, "a", "set", { value: 1, element: 1 }));
    await refused(rec(1, "a", "set", { value: 1, member: "m" }));
    await refused(rec(1, "a", "delete", { value: 1 }));
    await refused(rec(1, "a", "delete", { field: "f" }));
    await refused(rec(1, "a", "setField", { value: 1 }));
    await refused(rec(1, "a", "setField", { field: "", value: 1 }));
    await refused(rec(1, "a", "setField", { field: "a\u0000b", value: 1 }));
    await refused(rec(1, "a", "setField", { field: "f" }));
    await refused(
      rec(1, "a", "setField", { field: "f", value: 1, element: 1 }),
    );
    await refused(rec(1, "a", "removeField", { field: "f", value: 1 }));
    await refused(rec(1, "a", "removeField", {}));
    await refused(rec(1, "a", "add", {}));
    await refused(rec(1, "a", "add", { element: 1, value: 1 }));
    await refused(rec(1, "a", "add", { element: 1, field: "f" }));
    await refused(rec(1, "a", "remove", { element: 1, value: 1 }));
    await refused(rec(1, "a", "remove", {}));
  });

  it("refuses the operations a record does not have, and an element it cannot spell", async () => {
    for (const op of ["clear", "setMember", "removeMember", "nope"])
      await refused(rec(1, "a", op, { member: "m", value: 1 }));
    await refused(rec(1, "a", "add", { element: Number.NaN }));
    await refused(rec(1, "a", "add", { element: "\ud800" }));
  });

  it("a locked codec refuses with sync-locked before sealing a record", async () => {
    const locked: HostCodec = { ...codec, locked: true };
    await expect(
      sealPush(push([rec(1, "a", "set", { value: 1 })]), locked, []),
    ).rejects.toMatchObject({ code: "sync-locked" });
  });

  it("one bad record mutation in a batch returns nothing", async () => {
    await expect(
      sealPush(
        push([
          rec(1, "a", "set", { value: 1 }),
          rec(2, "", "set", { value: 1 }),
        ]),
        codec,
        [],
      ),
    ).rejects.toMatchObject({ code: "invalid-options" });
  });

  it("recordRef names the pairs a record can have", () => {
    expect(recordRef(["saves", "a"])).toEqual(["saves", "a"]);
    expect(recordRef(["$settings", "a"])).toBeNull();
    expect(recordRef(["saves", "a", "b"])).toBeNull();
    expect(recordRef(undefined)).toBeNull();
  });
});

describe("openPull: records", () => {
  const id = "slot-1";
  const wireId = () => bl("record", "saves", id);
  const valueRow = async (v: SyncJson, over: Record<string, Json> = {}) => ({
    record: ["saves", await wireId()],
    ct: await seal("saves", id, v),
    version: 7,
    editedHlc: "0190f3a2c1b4:0003",
    ...over,
  });
  const cell = async (
    kind: "field" | "element",
    name: string,
    v: SyncJson,
    cid = id,
    r = root,
  ): Promise<Record<string, Json>> => {
    const canon = kind === "element" ? canonicalJson(v) : name;
    return {
      [kind]: await bl(kind, "saves", canon),
      ct: await seal(
        "saves",
        kind === "field"
          ? fieldEnvelopeName(cid, name)
          : elementEnvelopeName(cid, canon),
        v,
        r,
      ),
      ...(kind === "field" ? { editedHlc: "0190f3a2c1b4:0003" } : {}),
    };
  };
  const pull = (changes: Json[], extra: Record<string, Json> = {}) =>
    openPull({ changes, ...extra }, codec, extra.ctx as never);

  it("opens a value: the plaintext id, the value, sealed, and no ct", async () => {
    const out = await pull([await valueRow({ hp: 10 })]);
    expect((out.body as any).changes[0]).toEqual({
      record: ["saves", id],
      value: { hp: 10 },
      version: 7,
      editedHlc: "0190f3a2c1b4:0003",
    });
    expect(out.opened.changes).toEqual([{ sealed: true }]);
  });

  it("a plaintext id never opens, even with a good envelope", async () => {
    const row = await valueRow(1, { record: ["saves", id] });
    const out = await pull([row]);
    expect(out.opened.changes).toEqual([{ invalid: true }]);
    const e = (out.body as any).changes[0];
    expect("value" in e || "ct" in e).toBe(false);
    expect(e.record).toEqual(["saves", id]);
  });

  it("an envelope placed under another record's blinded id is invalid", async () => {
    const other = await bl("record", "saves", "slot-2");
    const out = await pull([await valueRow(1, { record: ["saves", other] })]);
    expect(out.opened.changes).toEqual([{ invalid: true }]);
    expect((out.body as any).changes[0].record).toEqual(["saves", other]);
  });

  it("an envelope served under another collection, a wrong root or a bad ct is invalid", async () => {
    const wrongColl = await valueRow(1, {
      record: ["other", await bl("record", "other", id)],
    });
    const wrongRoot = await valueRow(1, {
      ct: await seal("saves", id, 1, otherRoot),
    });
    const bad = await valueRow(1, { ct: "not*base64" });
    const flipped = await valueRow(1);
    flipped.ct =
      flipped.ct.slice(0, -2) + (flipped.ct.endsWith("A") ? "BB" : "AA");
    const out = await pull([wrongColl, wrongRoot, bad, flipped]);
    expect(out.opened.changes).toEqual([
      { invalid: true },
      { invalid: true },
      { invalid: true },
      { invalid: true },
    ]);
  });

  it("a collection in the $ namespace, an empty id, or a NUL never opens", async () => {
    const env = await seal("$settings", id, 1);
    const rows: Json[] = [
      {
        record: ["$settings", await bl("record", "$settings", id)],
        ct: env,
        version: 1,
      },
      { record: ["saves", ""], ct: env, version: 1 },
      { record: ["saves"], ct: env, version: 1 },
    ];
    const out = await pull(rows);
    expect(out.opened.changes).toEqual([
      { invalid: true },
      { invalid: true },
      { invalid: true },
    ]);
  });

  it("a plaintext record row is legacy: seq is its version, and a claimed seal is stripped", async () => {
    const out = await pull([
      {
        record: ["saves", "slot-9"],
        value: { hp: 1 },
        version: 3,
        sealed: true,
        seq: 99,
        invalid: true,
      },
    ]);
    expect((out.body as any).changes[0]).toEqual({
      record: ["saves", "slot-9"],
      value: { hp: 1 },
      version: 3,
    });
    expect(out.opened.changes).toEqual([{ seq: 3 }]);
  });

  it("a row with two sealed shapes is invalid", async () => {
    const f = await cell("field", "hp", 10);
    const out = await pull([
      { ...(await valueRow(1)), fields: [f] },
      {
        record: ["saves", await wireId()],
        fields: [f],
        elements: [],
        version: 1,
      },
    ]);
    expect(out.opened.changes).toEqual([{ invalid: true }, { invalid: true }]);
  });

  it("opens a merge record's fields into one object, and checks each blinded name", async () => {
    const row = {
      record: ["saves", await wireId()],
      fields: [await cell("field", "hp", 10), await cell("field", "gold", 3)],
      version: 8,
      editedHlc: "0190f3a2c1b4:0004",
    };
    const out = await pull([row]);
    expect((out.body as any).changes[0]).toEqual({
      record: ["saves", id],
      value: { hp: 10, gold: 3 },
      version: 8,
      editedHlc: "0190f3a2c1b4:0004",
    });
    expect(out.opened.changes).toEqual([{ sealed: true }]);

    // a field served under another blinded field name, a duplicate, or another record's cell
    const swapped = {
      ...(await cell("field", "hp", 10)),
      field: await bl("field", "saves", "mp"),
    };
    const dup = await cell("field", "hp", 10);
    const foreign = await cell("field", "hp", 10, "slot-2");
    const bad = await pull(
      [swapped, [dup, dup], foreign].map(
        (f) =>
          ({
            record: ["saves", row.record[1]],
            fields: Array.isArray(f) ? f : [f],
            version: 8,
          }) as Json,
      ),
    );
    expect(bad.opened.changes).toEqual([
      { invalid: true },
      { invalid: true },
      { invalid: true },
    ]);
  });

  it("a __proto__ field is data, not a prototype", async () => {
    const out = await pull([
      {
        record: ["saves", await wireId()],
        fields: [await cell("field", "__proto__", { x: 1 })],
        version: 1,
      },
    ]);
    const v = (out.body as any).changes[0].value;
    expect(Object.getPrototypeOf(v)).toBe(Object.prototype);
    expect(Object.keys(v)).toEqual(["__proto__"]);
    expect(({} as any).x).toBeUndefined();
  });

  it("opens a union record's elements in the served order, and refuses a swapped element", async () => {
    const a = { id: 7, tag: "a" };
    const row = {
      record: ["saves", await wireId()],
      elements: [
        await cell("element", "", "shield"),
        await cell("element", "", a),
      ],
      version: 9,
    };
    const out = await pull([row]);
    expect((out.body as any).changes[0].value).toEqual(["shield", a]);
    expect(out.opened.changes).toEqual([{ sealed: true }]);

    // the cell of "shield" served under the blinded element of the object
    const swapped = {
      ...(await cell("element", "", "shield")),
      element: await bl("element", "saves", canonicalJson(a)),
    };
    const dup = await cell("element", "", "shield");
    const bad = await pull(
      [[swapped], [dup, dup]].map(
        (els) => ({ record: row.record, elements: els, version: 9 }) as Json,
      ),
    );
    expect(bad.opened.changes).toEqual([{ invalid: true }, { invalid: true }]);
  });

  it("a record with no cells reads empty, and maps to a held id", async () => {
    const empty: Json = {
      record: ["saves", await wireId()],
      fields: [],
      version: 4,
    };
    const unknown = await pull([empty]);
    expect(unknown.opened.changes).toEqual([{ sealed: true }]);
    expect((unknown.body as any).changes[0].value).toEqual({});
    expect((unknown.body as any).changes[0].record[1]).toBe(await wireId());
    const held = await openPull({ changes: [empty] }, codec, {
      recordKeys: [["saves", id]],
    });
    expect((held.body as any).changes[0].record).toEqual(["saves", id]);
    const elems = await openPull(
      {
        changes: [{ record: (empty as any).record, elements: [], version: 4 }],
      },
      codec,
      { recordKeys: [["saves", id]] },
    );
    expect((elems.body as any).changes[0].value).toEqual([]);
  });

  it("sealed cells with no envelope container are not a plaintext row", async () => {
    const out = await pull([
      { setting: "a.b", scope: "user", fields: [], version: 2 },
    ]);
    expect(out.opened.changes).toEqual([{ invalid: true }]);
  });

  it("maps a record tombstone back only for a record the machine holds", async () => {
    const t = (rid: string, c = "saves"): Json => ({
      record: [c, rid],
      editedHlc: "0190f3a2c1b4:0003",
    });
    const w = await wireId();
    const out = await openPull(
      {
        tombstones: [
          t(w),
          t(await bl("record", "saves", "slot-2")),
          t(w, "other"),
          { setting: "x:abc" },
          "junk",
        ],
      },
      codec,
      {
        recordKeys: [
          ["saves", id],
          ["$bad", "x"],
          ["saves", ""],
        ],
      },
    );
    const ts = (out.body as any).tombstones;
    expect(ts[0]).toEqual({
      record: ["saves", id],
      editedHlc: "0190f3a2c1b4:0003",
    });
    expect(ts[1].record[1]).toBe(await bl("record", "saves", "slot-2"));
    expect(ts[2].record).toEqual(["other", w]);
    expect(ts[3]).toEqual({ setting: "x:abc" });
    expect(ts[4]).toBe("junk");
    // without recordKeys nothing maps
    const none = await openPull({ tombstones: [t(w)] }, codec);
    expect((none.body as any).tombstones[0].record[1]).toBe(w);
  });

  describe("a conflict's server copy", () => {
    const muts = (ms: Json[]): WireMutation[] =>
      ms as unknown as WireMutation[];
    const result = (mutationId: number, server: Json): Json => ({
      mutationId,
      status: "conflict",
      server,
    });
    it("opens under the mutation's own record", async () => {
      const out = await openPull(
        {
          results: [
            result(1, {
              ct: await seal("saves", id, { hp: 5 }),
              version: 9,
              editedHlc: "0190f3a2c1b4:0003",
            }),
          ],
        },
        codec,
        { mutations: muts([rec(1, id, "set", { baseVersion: 3 })]) },
      );
      expect((out.body as any).results[0].server).toEqual({
        value: { hp: 5 },
        version: 9,
        editedHlc: "0190f3a2c1b4:0003",
      });
      expect(out.opened.conflicts).toEqual({ 1: { sealed: true } });
    });

    it("is invalid for another record's envelope, an unplaced mutation, or a malformed reference", async () => {
      const server = { ct: await seal("saves", "slot-2", 1), version: 9 };
      const out = await openPull(
        {
          results: [
            result(1, server),
            result(2, { ct: await seal("saves", id, 1), version: 9 }),
            result(3, { ct: await seal("saves", id, 1), version: 9 }),
          ],
        },
        codec,
        {
          mutations: muts([
            rec(1, id, "set", { baseVersion: 3 }),
            {
              mutationId: 3,
              target: { record: ["saves", ""] },
              op: "set",
              value: 1,
            },
          ]),
        },
      );
      expect(out.opened.conflicts).toEqual({
        1: { invalid: true },
        2: { invalid: true },
        3: { invalid: true },
      });
      for (const r of (out.body as any).results)
        expect("value" in r.server || "ct" in r.server).toBe(false);
    });

    it("opens a merge record's fields against the mutation's id", async () => {
      const copy = {
        fields: [await cell("field", "hp", 5)],
        version: 9,
        editedHlc: "0190f3a2c1b4:0003",
      };
      const foreign = {
        fields: [await cell("field", "hp", 5, "slot-2")],
        version: 9,
      };
      const out = await openPull(
        { results: [result(1, copy), result(2, foreign)] },
        codec,
        {
          mutations: muts([
            rec(1, id, "setField", { field: "hp", editedHlc: "h" }),
            rec(2, id, "setField", { field: "hp", editedHlc: "h" }),
          ]),
        },
      );
      expect((out.body as any).results[0].server.value).toEqual({ hp: 5 });
      expect("fields" in (out.body as any).results[0].server).toBe(false);
      expect(out.opened.conflicts).toEqual({
        1: { sealed: true },
        2: { invalid: true },
      });
    });

    it("a plaintext copy is legacy (seq is its version)", async () => {
      const out = await openPull(
        { results: [result(1, { value: { hp: 1 }, version: 2 })] },
        codec,
        { mutations: muts([rec(1, id, "set", { baseVersion: 1 })]) },
      );
      expect(out.opened.conflicts).toEqual({ 1: { seq: 2 } });
    });

    it("a setting mutation's copy is still opened as a setting", async () => {
      const out = await openPull(
        {
          results: [
            result(1, {
              ct: await seal("$settings", "audio.volume", 0.3),
              version: 2,
            }),
          ],
        },
        codec,
        {
          mutations: muts([
            {
              mutationId: 1,
              target: { setting: "audio.volume", scope: "user" },
              op: "set",
              value: 1,
            },
          ]),
        },
      );
      expect((out.body as any).results[0].server.value).toBe(0.3);
    });
  });

  it("round-trips: what sealPush sends for a value, openPull reads back under the same names", async () => {
    const sent = await sealOne(rec(1, id, "set", { value: [1, 2] }));
    const out = await pull([
      { record: sent.target.record, ct: sent.ct, version: 1 },
    ]);
    expect((out.body as any).changes[0]).toMatchObject({
      record: ["saves", id],
      value: [1, 2],
    });
    expect(isBlindedName(sent.target.record[1])).toBe(true);
  });
});

describe("openPull into CloudSyncMachine.receive: records", () => {
  const T0 = 1_760_000_000_000;
  const ALICE = "sub_alice";
  const id = "slot-1";
  const opts = (): CloudSyncOptions => ({
    product: "demo",
    catalog: {
      settings: [],
      collections: [{ name: "saves", policy: "revision" }],
    },
    document: { values: {}, locked: [] },
    now: T0,
    offsetMs: 0,
    contacted: false,
    subject: ALICE,
    network: "online",
    newClientId: () => `c_${"client1".padStart(22, "0")}`,
    encryption: "e2e",
    hasRoot: true,
  });
  const reply = (over: Record<string, Json>): Json => ({
    encryption: "e2e",
    subject: ALICE,
    cursor: 5,
    more: false,
    serverNow: T0,
    catalogVersion: 1,
    lastMutationId: 0,
    changes: [],
    tombstones: [],
    aliases: {},
    usage: { bytes: 0, settings: 0, records: 1, files: 0 },
    quota: { bytes: 1 << 28, files: true },
    ...over,
  });
  const receive = async (
    m: CloudSyncMachine,
    over: Record<string, Json>,
    recordKeys: Array<[string, string]> = [],
  ) => {
    const r = await openPull(reply(over), codec, { recordKeys });
    m.receive({ status: 200, body: r.body }, r.opened as OpenedBody);
  };
  const first = (): [CloudSyncMachine, SyncRequest] => {
    const m = new CloudSyncMachine(opts());
    return [m, m.takeRequests()[0] as SyncRequest];
  };

  it("reads a sealed record, a legacy plaintext one, and refuses a record placed under another id", async () => {
    const [m, req] = first();
    expect(req.method).toBe("GET");
    await receive(m, {
      encryptionSince: 10,
      changes: [
        {
          record: ["saves", await bl("record", "saves", id)],
          ct: await seal("saves", id, { hp: 10 }),
          version: 11,
        },
        { record: ["saves", "old"], value: { hp: 1 }, version: 3 },
        {
          record: ["saves", await bl("record", "saves", "slot-3")],
          ct: await seal("saves", "slot-2", { hp: 666 }),
          version: 12,
        },
      ],
    });
    expect(m.record("saves", id)).toMatchObject({ value: { hp: 10 } });
    expect(m.record("saves", "old")).toMatchObject({ value: { hp: 1 } });
    expect(m.record("saves", "slot-2")).toBeNull();
    expect(m.record("saves", "slot-3")).toBeNull();
  });

  it("a record tombstone removes a held record once mapped back", async () => {
    const [m] = first();
    await receive(m, {
      encryptionSince: 10,
      more: true,
      changes: [
        {
          record: ["saves", await bl("record", "saves", id)],
          ct: await seal("saves", id, 1),
          version: 11,
        },
      ],
    });
    expect(m.record("saves", id)).not.toBeNull();
    expect(m.takeRequests()).toHaveLength(1);
    await receive(
      m,
      {
        cursor: 6,
        tombstones: [
          {
            record: ["saves", await bl("record", "saves", id)],
            editedHlc: "h",
          },
        ],
      },
      [["saves", id]],
    );
    expect(m.record("saves", id)).toBeNull();
  });
});

// ── the corpus rows ──────────────────────────────────────────────────────────────────────────

interface RecordCase {
  id: string;
  rootHex: string;
  collection: string;
  name: string;
  envelopeHex: string;
  record?: { kind: "value" | "field" | "element"; id: string; name?: string };
  expect: { result: string; name?: string; reason?: string };
}
const VECTORS = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "conformance",
      "corpus",
      "v2",
      "sync-vectors.json",
    ),
    "utf8",
  ),
) as { envelopeCases: RecordCase[] };
const unhex = (h: string) => new Uint8Array(Buffer.from(h, "hex"));
const rows = VECTORS.envelopeCases.filter((c) => c.record !== undefined);

describe("record envelope rows (envelopeCases) through openPull", () => {
  it("the corpus holds the record rows", () => {
    expect(rows.length).toBeGreaterThanOrEqual(15);
  });

  for (const c of rows) {
    it(`${c.id}: ${c.expect.result === "ok" ? "opens" : "is invalid"}`, async () => {
      const k = codecOf(unhex(c.rootHex));
      const w = c.record!;
      const ct = b64(unhex(c.envelopeHex));
      const change: Json =
        w.kind === "value"
          ? { record: [c.collection, w.id], ct, version: 5 }
          : w.kind === "field"
            ? {
                record: [c.collection, w.id],
                fields: [{ field: w.name ?? null, ct, editedHlc: "h" }],
                version: 5,
              }
            : {
                record: [c.collection, w.id],
                elements: [{ element: w.name ?? null, ct }],
                version: 5,
              };
      const out = await openPull({ changes: [change] }, k);
      if (c.expect.result === "ok") {
        expect(out.opened.changes).toEqual([{ sealed: true }]);
        expect((out.body as any).changes[0].record[0]).toBe(c.collection);
      } else {
        expect(out.opened.changes).toEqual([{ invalid: true }]);
        const e = (out.body as any).changes[0];
        expect("value" in e || "ct" in e).toBe(false);
        expect(e.record).toEqual([c.collection, w.id]);
      }
    });
  }

  it("seal-record-value: the envelope's k is the plaintext id the row gets", async () => {
    const c = rows.find((x) => x.id === "seal-record-value")!;
    const out = await openPull(
      {
        changes: [
          {
            record: [c.collection, c.record!.id],
            ct: b64(unhex(c.envelopeHex)),
            version: 1,
          },
        ],
      },
      codecOf(unhex(c.rootHex)),
    );
    expect((out.body as any).changes[0].record).toEqual(["saves", "slot-1"]);
  });
});
