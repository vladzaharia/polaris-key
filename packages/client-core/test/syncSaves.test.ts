import { describe, expect, it } from "vitest";
import {
  e2eFileCodec,
  memoryChunkCache,
  memoryJournal,
  SAVE_FILE_BINDING_KEY,
  SavesClient,
  SavesError,
  serverFileCodec,
  TransferEngine,
  webCryptoSyncPort as port,
  type FileCodec,
  type SaveFileRef,
  type SaveOutcome,
  type SaveRecord,
  type SaveRecords,
  type SaveSetResult,
} from "../src/sync/index.js";
import type { Json } from "../src/cloud-sync.js";
import { fail, MIB, noise } from "./syncTransferFixtures.js";
import { FakeServer } from "./syncTransferServer.js";

type Meta = { [k: string]: Json };

/** The records layer the machine will bind (U-22.5): versions bump on finalize and on set. */
class FakeRecords implements SaveRecords {
  recs = new Map<
    string,
    { version: number; value: Meta; file: SaveFileRef | null }
  >();
  counter = 0;
  log: string[] = [];
  /** Which wire record each file version belongs to. */
  owner = new Map<number, string>();
  constructor(
    readonly server: FakeServer,
    readonly e2e: boolean,
  ) {
    const finalize = server.finalize;
    server.finalize = async (t, r) => {
      server.nextVersion = () => this.bump(t.record);
      const reply = await finalize(t, r);
      if (reply.ok) {
        this.log.push("finalize");
        const rec = this.recs.get(t.record)!;
        rec.file = { ...reply.value };
      }
      return reply;
    };
    const begin = server.begin;
    server.begin = async (t, r) => {
      this.log.push("begin");
      const cur = this.recs.get(t.record);
      if (r.baseVersion === "*" && cur)
        return fail(409, "revision_conflict", {
          body: { server: { version: cur.version } },
        });
      if (typeof r.baseVersion === "number" && cur?.version !== r.baseVersion)
        return fail(409, "revision_conflict", {
          body: { server: { version: cur?.version ?? 0 } },
        });
      return begin(t, r);
    };
    server.revisions = async (t) => ({
      ok: true as const,
      value: {
        revisions: [...server.files]
          .reverse()
          .filter((f) => this.owner.get(f.version) === t.record)
          .map((f) => ({
            version: f.version,
            size: f.size,
            sha256: f.sha256,
            format: f.format,
            createdAt: 0,
          })),
      },
    });
  }
  private bump(wire: string): number {
    const rec = this.recs.get(wire) ?? { version: 0, value: {}, file: null };
    this.recs.set(wire, rec);
    rec.version = ++this.counter;
    this.owner.set(rec.version, wire);
    return rec.version;
  }
  wireId = (id: string) => (this.e2e ? `x:${id}` : id);
  private idOf = (wire: string) => (this.e2e ? wire.slice(2) : wire);
  private view(wire: string): SaveRecord {
    const r = this.recs.get(wire)!;
    return {
      id: this.idOf(wire),
      version: r.version,
      value: r.value,
      file: r.file,
    };
  }
  async list() {
    return [...this.recs.keys()].map((w) => this.view(w));
  }
  async get(id: string) {
    return this.recs.has(this.wireId(id)) ? this.view(this.wireId(id)) : null;
  }
  failSet: string | null = null;
  async set(
    id: string,
    value: Meta,
    base: number | "*",
  ): Promise<SaveSetResult> {
    this.log.push("set");
    if (this.failSet)
      return { ok: false, reason: "rejected", code: this.failSet };
    const wire = this.wireId(id);
    const cur = this.recs.get(wire);
    if (base === "*" ? cur !== undefined : cur?.version !== base)
      return {
        ok: false,
        reason: "conflict",
        server: cur ? this.view(wire) : null,
      };
    const rec = cur ?? { version: 0, value: {}, file: null };
    this.recs.set(wire, rec);
    rec.value = value;
    rec.version = ++this.counter;
    return { ok: true, version: rec.version };
  }
  async delete(id: string, base: number): Promise<SaveSetResult> {
    const wire = this.wireId(id);
    const cur = this.recs.get(wire);
    if (cur?.version !== base)
      return {
        ok: false,
        reason: "conflict",
        server: cur ? this.view(wire) : null,
      };
    this.recs.delete(wire);
    return { ok: true, version: ++this.counter };
  }
}

const ROOT = Uint8Array.from({ length: 32 }, (_, i) => i + 9);

function rig(
  over: {
    e2e?: boolean;
    delta?: boolean;
    maxBytes?: number;
    saveFormatVersion?: number;
  } = {},
) {
  const server = new FakeServer();
  const e2e = over.e2e ?? false;
  const records = new FakeRecords(server, e2e);
  const codec: FileCodec = e2e
    ? e2eFileCodec(port, ROOT, "saves")
    : serverFileCodec(port);
  const journal = memoryJournal();
  const engine = new TransferEngine({
    transport: server,
    journal,
    sleep: async () => {},
    random: () => 0.5,
  });
  const saves = new SavesClient({
    records,
    engine,
    transport: server,
    codec,
    delta: over.delta ?? false,
    cache: memoryChunkCache(),
    ...(over.maxBytes !== undefined ? { maxBytes: over.maxBytes } : {}),
    ...(over.saveFormatVersion !== undefined
      ? { saveFormatVersion: over.saveFormatVersion }
      : {}),
  });
  return { server, records, codec, journal, engine, saves };
}

const done = (o: SaveOutcome) => {
  if (o.state !== "done" || "kept" in o)
    throw new Error(`not done: ${JSON.stringify(o)}`);
  return o;
};

const small = noise(200_000, 3);
const meta: Meta = { chapter: "One", progress: 0.4, formatVersion: 1 };

/** A save at v1, written again elsewhere, then written here against v1: the conflict. */
async function conflictRig(
  e2e: boolean,
  mine: Uint8Array,
  chapter = "Mine",
  theirs: Uint8Array = noise(900, 8),
) {
  const r = rig({ e2e });
  const v1 = done(await r.saves.write("slot1", small, meta).done);
  done(await r.saves.write("slot1", theirs, { ...meta, chapter: "Two" }).done);
  const out = await r.saves.write(
    "slot1",
    mine,
    { ...meta, chapter },
    { baseVersion: v1.version },
  ).done;
  if (out.state !== "conflict") throw new Error("conflict");
  return { r, conflict: out.conflict, theirs };
}

describe.each([
  ["server mode", false],
  ["end-to-end", true],
])("saves, %s", (_name, e2e) => {
  it("writes a save and reads it back", async () => {
    const r = rig({ e2e });
    const out = done(await r.saves.write("slot1", small, meta).done);
    expect(out.file.size).toBeGreaterThan(0);
    const read = await r.saves.read("slot1");
    expect(read).toMatchObject({ ok: true, id: "slot1", metadata: meta });
    if (!read.ok) return;
    expect(Buffer.from(read.bytes!).equals(Buffer.from(small))).toBe(true);
    const [one] = await r.saves.list();
    expect(one).toMatchObject({
      id: "slot1",
      newerFormat: false,
      metadata: meta,
    });
    expect(SAVE_FILE_BINDING_KEY in one!.metadata).toBe(false);
    // The binding is in the record in E2E mode only.
    const stored = r.records.recs.get(r.records.wireId("slot1"))!.value;
    expect(SAVE_FILE_BINDING_KEY in stored).toBe(e2e);
    if (e2e) {
      expect(stored[SAVE_FILE_BINDING_KEY]).toEqual({
        sha256: out.file.sha256,
        size: out.file.size,
        format: "whole",
      });
      const probe = Buffer.from(small.subarray(5000, 5064));
      expect(Buffer.from(r.server.files[0]!.bytes).includes(probe)).toBe(false);
    }
  });

  it("uploads the file before it pushes the metadata (D-3)", async () => {
    const r = rig({ e2e });
    done(await r.saves.write("slot1", small, meta).done);
    expect(r.records.log).toEqual(["begin", "finalize", "set"]);
  });

  it("sends a chunked save as a delta, and reads it back", async () => {
    const r = rig({ e2e, delta: true });
    const big = noise(3 * MIB, 21);
    const first = done(await r.saves.write("slot1", big, meta).done);
    expect(first.file.format).toBe("chunks");
    const puts = r.server.chunkPuts.length;
    const edited = Uint8Array.from(big);
    for (let i = 0; i < 40; i++) edited[1_800_000 + i]! ^= 0x7f;
    r.server.chunkPuts.length = 0;
    done(await r.saves.write("slot1", edited, { ...meta, progress: 0.5 }).done);
    expect(r.server.chunkPuts.length).toBeGreaterThan(0);
    expect(r.server.chunkPuts.length).toBeLessThan(puts);
    const read = await r.saves.read("slot1");
    expect(
      read.ok && Buffer.from(read.bytes!).equals(Buffer.from(edited)),
    ).toBe(true);
    expect(read.ok && read.metadata.progress).toBe(0.5);
  });

  it("reports progress and a handle that ends done", async () => {
    const r = rig({ e2e });
    const seen: number[] = [];
    const t = r.saves.write("slot1", small, meta, {
      onProgress: (d, total) => seen.push(d / total),
    });
    expect(t.state).toBe("running");
    await t.done;
    expect(t.state).toBe("done");
    expect(seen.at(-1)).toBe(1);
  });

  it("turns a stale baseVersion into a conflict that carries the server's copy", async () => {
    const { conflict } = await conflictRig(e2e, noise(700, 9));
    expect(conflict).toMatchObject({
      id: "slot1",
      bothAvailable: true,
      remote: { metadata: { chapter: "Two" } },
    });
    expect(conflict.serverVersion).toBe(conflict.remote!.version);
  });

  it("settles a conflict: keep remote writes nothing", async () => {
    const mine = noise(700, 9);
    const { r, conflict } = await conflictRig(e2e, mine);
    const calls = r.server.calls.length;
    const kept = await r.saves.resolve(conflict, "remote", mine).done;
    expect(kept).toMatchObject({ state: "done", kept: "remote" });
    expect(r.server.calls.length).toBe(calls);
  });

  it("settles a conflict: keep local writes on top of the server's version", async () => {
    const mine = noise(700, 9);
    const { r, conflict } = await conflictRig(e2e, mine);
    done(await r.saves.resolve(conflict, "local", mine).done);
    const read = await r.saves.read("slot1");
    expect(read.ok && read.metadata.chapter).toBe("Mine");
    expect(read.ok && Buffer.from(read.bytes!).equals(Buffer.from(mine))).toBe(
      true,
    );
  });

  it("settles a conflict: keep both writes a copy in a free slot", async () => {
    const mine = noise(700, 9);
    const { r, conflict, theirs } = await conflictRig(e2e, mine);
    const both = done(await r.saves.resolve(conflict, "both", mine).done);
    expect(both.copyId).toBe("slot1.copy");
    const a = await r.saves.read("slot1");
    const b = await r.saves.read("slot1.copy");
    expect(a.ok && a.metadata.chapter).toBe("Two");
    expect(a.ok && Buffer.from(a.bytes!).equals(Buffer.from(theirs))).toBe(
      true,
    );
    expect(b.ok && b.metadata.chapter).toBe("Mine");
    expect(b.ok && Buffer.from(b.bytes!).equals(Buffer.from(mine))).toBe(true);
  });

  it("refuses a new save when the 16 slots are full, but updates an existing one", async () => {
    const r = rig({ e2e });
    for (let i = 0; i < 16; i++)
      done(await r.saves.write(`s${i}`, noise(500, i + 1), meta).done);
    const out = await r.saves.write("extra", small, meta).done;
    expect(out).toMatchObject({
      state: "failed",
      error: { code: "slots-full" },
    });
    done(await r.saves.write("s3", noise(600, 99), meta).done);
    // And `both` is not offered on a conflict while the slots are full.
    const stale = await r.saves.write("s4", small, meta, { baseVersion: 1 })
      .done;
    if (stale.state !== "conflict") throw new Error("conflict");
    expect(stale.conflict.bothAvailable).toBe(false);
    const both = await r.saves.resolve(stale.conflict, "both", small).done;
    expect(both).toMatchObject({
      state: "failed",
      error: { code: "slots-full" },
    });
  });

  it("refuses what cannot be a save before anything is sent", async () => {
    const r = rig({ e2e, maxBytes: 1000 });
    const calls = () => r.server.calls.length;
    expect(await r.saves.write("a", small, meta).done).toMatchObject({
      state: "failed",
      error: { code: "too-large" },
    });
    expect(
      await r.saves.write("a", noise(10, 1), { [SAVE_FILE_BINDING_KEY]: 1 })
        .done,
    ).toMatchObject({ state: "failed", error: { code: "invalid-save" } });
    expect(await r.saves.write("../a", noise(10, 1), meta).done).toMatchObject({
      state: "failed",
      error: { code: "invalid-save" },
    });
    expect(calls()).toBe(0);
  });

  it("deletes a save", async () => {
    const r = rig({ e2e });
    done(await r.saves.write("slot1", small, meta).done);
    expect(await r.saves.delete("slot1")).toMatchObject({ ok: true });
    expect(await r.saves.read("slot1")).toEqual({
      ok: false,
      reason: "not-found",
    });
    expect(await r.saves.delete("slot1")).toMatchObject({ ok: false });
  });

  it("lists the revisions of a save, newest first", async () => {
    const r = rig({ e2e });
    done(await r.saves.write("slot1", small, meta).done);
    done(await r.saves.write("slot1", noise(5000, 4), meta).done);
    const revs = await r.saves.revisions("slot1");
    expect(revs.length).toBe(2);
    expect(revs[0]!.version).toBeGreaterThan(revs[1]!.version);
  });

  it("reads a save of a newer format as metadata only", async () => {
    const r = rig({ e2e, saveFormatVersion: 2 });
    done(
      await r.saves.write("slot1", small, { ...meta, formatVersion: 3 }).done,
    );
    done(
      await r.saves.write("slot2", small, { ...meta, formatVersion: 2 }).done,
    );
    const gets = r.server.fileGets.length;
    expect(await r.saves.read("slot1")).toEqual({
      ok: false,
      reason: "newer-format",
      formatVersion: 3,
      supported: 2,
    });
    expect(r.server.fileGets.length).toBe(gets);
    expect((await r.saves.read("slot2")).ok).toBe(true);
    const list = await r.saves.list();
    expect(list.map((s) => [s.id, s.newerFormat])).toEqual([
      ["slot1", true],
      ["slot2", false],
    ]);
  });
});

describe("saves, end-to-end binding (D-3)", () => {
  it("never reads a torn write: the file of an unfinished write is not the save", async () => {
    const r = rig({ e2e: true });
    const v1 = noise(50_000, 1);
    done(await r.saves.write("slot1", v1, meta).done);
    // The second write stores its file and then fails to push the metadata.
    r.records.failSet = "unavailable";
    const out = await r.saves.write("slot1", noise(60_000, 2), meta).done;
    expect(out).toMatchObject({ state: "failed" });
    expect(r.server.files.length).toBe(2);
    const read = await r.saves.read("slot1");
    expect(read.ok && Buffer.from(read.bytes!).equals(Buffer.from(v1))).toBe(
      true,
    );
    // The record shows the newer file; the reader went back to the revision the binding names.
    expect(r.records.recs.get("x:slot1")!.file!.version).toBe(
      r.server.files[1]!.version,
    );
  });

  it("refuses a Worker that points one slot at another slot's file", async () => {
    const r = rig({ e2e: true });
    done(await r.saves.write("a", noise(40_000, 1), meta).done);
    done(await r.saves.write("b", noise(41_000, 2), meta).done);
    const b = r.records.recs.get("x:b")!;
    const a = r.records.recs.get("x:a")!;
    // The record layer is told slot a's file is b's, and the revision list agrees.
    a.file = { ...b.file! };
    r.server.revisions = async () => ({
      ok: true,
      value: {
        revisions: [{ ...b.file!, createdAt: 0 }],
      },
    });
    await expect(r.saves.read("a")).rejects.toMatchObject({
      code: "sync-file-invalid",
      detail: "binding",
    });
  });

  it("refuses bytes swapped under the right record (hash of the stored file)", async () => {
    const r = rig({ e2e: true });
    done(await r.saves.write("a", noise(40_000, 1), meta).done);
    done(await r.saves.write("b", noise(41_000, 2), meta).done);
    const other = r.server.files[1]!.bytes;
    r.server.tamperFile = (_q, body) => ({
      ...body,
      bytes: other.subarray(0, body.bytes.length),
    });
    await expect(r.saves.read("a")).rejects.toBeInstanceOf(SavesError);
    await expect(r.saves.read("a")).rejects.toMatchObject({
      code: "sync-file-invalid",
    });
  });

  it("treats a record with no binding as having no file, whatever the server attaches", async () => {
    const r = rig({ e2e: true });
    done(await r.saves.write("a", noise(40_000, 1), meta).done);
    const rec = r.records.recs.get("x:a")!;
    const { [SAVE_FILE_BINDING_KEY]: _drop, ...bare } = rec.value;
    rec.value = bare;
    const read = await r.saves.read("a");
    expect(read).toMatchObject({ ok: true, file: null, bytes: null });
    expect((await r.saves.list())[0]!.file).toBeNull();
  });

  it("refuses a malformed binding", async () => {
    const r = rig({ e2e: true });
    done(await r.saves.write("a", noise(40_000, 1), meta).done);
    r.records.recs.get("x:a")!.value[SAVE_FILE_BINDING_KEY] = { sha256: "zz" };
    await expect(r.saves.read("a")).rejects.toMatchObject({
      code: "sync-file-invalid",
      detail: "binding",
    });
  });

  it("a tampered chunk of a chunked save is sync-file-invalid", async () => {
    const r = rig({ e2e: true, delta: true });
    done(await r.saves.write("a", noise(2 * MIB, 5), meta).done);
    r.server.tamperChunk = (_id, o) => {
      const x = Uint8Array.from(o);
      x[20]! ^= 1;
      return x;
    };
    await expect(r.saves.read("a")).rejects.toMatchObject({
      code: "sync-file-invalid",
      detail: "chunk-auth",
    });
  });
});

/** Blocks the first chunk PUT until `release()`; `held()` says it is waiting. */
function holdFirstPut(server: FakeServer) {
  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  let held = false;
  const put = server.putChunk;
  server.putChunk = async (...args) => {
    if (!held) {
      held = true;
      await gate;
    }
    return put(...args);
  };
  return { release, held: () => held };
}

const until = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 1000 && !cond(); i++)
    await new Promise((res) => setTimeout(res, 5));
  if (!cond()) throw new Error("timed out");
};

describe("saves, the transfer handle", () => {
  it("pauses, resumes and finishes without sending a stored chunk again", async () => {
    const r = rig({ delta: true });
    const big = noise(3 * MIB, 31);
    const hold = holdFirstPut(r.server);
    const t = r.saves.write("a", big, meta);
    await until(hold.held);
    t.pause();
    hold.release();
    await new Promise((res) => setTimeout(res, 50));
    expect(t.state).toBe("paused");
    const sent = r.server.chunkPuts.length;
    t.resume();
    const out = await t.done;
    expect(out.state).toBe("done");
    expect(t.state).toBe("done");
    // Each chunk was stored once across both runs.
    expect(r.server.chunkPuts.length).toBe(new Set(r.server.chunkPuts).size);
    expect(r.server.chunkPuts.length).toBeGreaterThan(sent);
    const read = await r.saves.read("a");
    expect(read.ok && Buffer.from(read.bytes!).equals(Buffer.from(big))).toBe(
      true,
    );
  });

  it("cancels: the upload is released, the journal is empty, and it is a state not an error", async () => {
    const r = rig({ delta: true });
    const hold = holdFirstPut(r.server);
    const t = r.saves.write("a", noise(3 * MIB, 32), meta);
    await until(hold.held);
    const c = t.cancel();
    hold.release();
    await c;
    expect(await t.done).toEqual({ state: "cancelled" });
    expect(t.state).toBe("cancelled");
    expect(r.server.aborted.length).toBe(1);
    expect(await r.journal.list()).toEqual([]);
    expect(r.records.recs.size).toBe(0);
  });

  it("reports a transfer failure as a state with an error", async () => {
    const r = rig();
    r.server.hook = (kind) =>
      kind === "begin" ? fail(403, "quota_exceeded") : undefined;
    const out = await r.saves.write("a", small, meta).done;
    expect(out).toMatchObject({
      state: "failed",
      error: { code: "transfer-failed", detail: "quota_exceeded" },
    });
  });
});
