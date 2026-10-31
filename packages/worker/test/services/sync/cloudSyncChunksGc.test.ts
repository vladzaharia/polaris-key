/**
 * U-37.5: reference counts and the collection of chunks (WIRE-CONTRACT-V5 §13.8.2, §13.8.3,
 * plans/U-22-U-23-U-37-U-41-slices.md D-7). Each rule has a test that fails without it: a chunk a
 * file names is never deleted, a chunk an open upload pins is never deleted, an unreferenced and
 * unpinned one is, one collection's chunk is never another's, and an erasure leaves nothing under
 * the person's chunk prefix.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NOW } from "../../seed.js";
import { installDigestStream } from "../../r2Mock.js";
import {
  absorbCloudSync,
  deleteCloudSync,
  deleteCloudSyncIfUnchanged,
  exportCloudSync,
} from "../../../src/services/sync/do/client.js";
import { SqlStore } from "../../../src/services/sync/do/sqlStore.js";
import { syncProductPurge } from "../../../src/services/sync/productDeletion.js";
import {
  SLUG,
  call,
  filesWorld,
  finalize,
  rows,
  uploadPath,
  usageOf,
  type FilesWorld,
} from "./cloudSyncFilesWorld.js";
import {
  beginChunks,
  chunkOf,
  closeSessionAfterPut,
  deleteRecord,
  holdUpload,
  planUpload,
  setClock,
  survivorOf,
  fireAlarm,
  keyOfChunk,
  personOf,
  manifestOf,
  planned,
  putChunk,
  putManifest,
  writeChunked,
  type TestChunk,
} from "./cloudSyncChunksWorld.js";

beforeAll(() => installDigestStream());
afterEach(() => vi.useRealTimers());

const DAY = 86_400_000;
const name = (w: FilesWorld) => `${SLUG}:${w.subject}`;
const alarm = fireAlarm;
const pin = personOf;
const clock = setClock;
const keyOf = keyOfChunk;
const chunkRefs = (w: FilesWorld, collection: string, c: TestChunk) =>
  rows(
    w,
    `SELECT refs FROM chunks WHERE collection = '${collection}' AND chunk_id = '${c.id}'`,
  )[0]?.refs;
const del = deleteRecord;

const TWO_DELTA = {
  schemaVersion: 1,
  entries: [],
  cloudSync: {
    encryption: "server",
    collections: [
      { name: "delta", label: "A", files: { delta: true, keepRevisions: 1 } },
      { name: "delta2", label: "B", files: { delta: true, keepRevisions: 1 } },
    ],
  },
};

describe("a record delete releases chunks", () => {
  it("frees the quota at once, deletes the unreferenced objects and rows at the alarm, and keeps a chunk another record names", async () => {
    const w = await filesWorld();
    const shared = chunkOf(1, 1000);
    const lonely = chunkOf(2, 2000);
    await writeChunked(w, "delta", "one", manifestOf(1, 150), [shared, lonely]);
    await writeChunked(w, "delta", "two", manifestOf(2, 151), [shared]);
    expect(chunkRefs(w, "delta", shared)).toBe(2);
    await del(w, "delta", "one");
    // The quota is given back when the last reference goes, before any byte leaves R2.
    expect(chunkRefs(w, "delta", shared)).toBe(1);
    expect(chunkRefs(w, "delta", lonely)).toBe(0);
    expect(w.r2.has(keyOf(w, "delta", lonely))).toBe(true);
    expect(usageOf(w).file_bytes).toBe(151 + shared.object.length);
    await alarm(w);
    expect(w.r2.has(keyOf(w, "delta", lonely))).toBe(false);
    expect(
      rows(w, `SELECT 1 FROM chunks WHERE chunk_id = '${lonely.id}'`),
    ).toEqual([]);
    // The shared chunk is still referenced: its object, its row and its charge are intact.
    expect(w.r2.has(keyOf(w, "delta", shared))).toBe(true);
    expect(chunkRefs(w, "delta", shared)).toBe(1);
    const res = await call(
      w,
      "GET",
      `/${SLUG}/sync/files/delta/chunks/${shared.id}`,
    );
    expect(res.status).toBe(200);
  });

  it("an R2 failure keeps the row and the object, and the alarm tries again", async () => {
    const w = await filesWorld();
    const a = chunkOf(1);
    await writeChunked(w, "delta", "one", manifestOf(1, 150), [a]);
    await del(w, "delta", "one");
    const realDelete = w.r2.delete.bind(w.r2);
    w.r2.delete = () => Promise.reject(new Error("r2 down"));
    await alarm(w);
    expect(rows(w, "SELECT refs FROM chunks")).toEqual([{ refs: 0 }]);
    expect(w.r2.has(keyOf(w, "delta", a))).toBe(true);
    expect(w.ns.instances.get(name(w))!.storage.alarm).not.toBeNull();
    w.r2.delete = realDelete;
    await alarm(w);
    expect(rows(w, "SELECT 1 FROM chunks")).toEqual([]);
    expect(w.r2.has(keyOf(w, "delta", a))).toBe(false);
  });
});

describe("a chunk the collector has begun to delete is answered missing", () => {
  const getChunk = (w: FilesWorld, c: TestChunk) =>
    call(w, "GET", `/${SLUG}/sync/files/delta/chunks/${c.id}`);

  /** Writes and deletes `a`; the collector's delete is `fail`ed (after reaching R2 or not). */
  async function interrupted(reached: boolean) {
    const w = await filesWorld();
    const a = chunkOf(1);
    await writeChunked(w, "delta", "one", manifestOf(1, 150), [a]);
    await del(w, "delta", "one");
    const real = w.r2.delete.bind(w.r2);
    w.r2.delete = async (...args: Parameters<typeof real>) => {
      if (reached) await real(...args);
      throw new Error("r2 did not answer");
    };
    await alarm(w);
    w.r2.delete = real;
    expect(w.r2.has(keyOf(w, "delta", a))).toBe(!reached);
    return { w, a };
  }

  /** Saves `a` again: the plan, the chunk, the manifest, finalize. */
  async function again(w: FilesWorld, a: TestChunk) {
    const manifest = manifestOf(2, 151);
    const up = await beginChunks(w, "delta", "two", manifest);
    const plan = await planned(w, "delta", "two", up.uploadId, [a]);
    expect(plan.missing).toEqual([a.id]);
    expect(plan.present).toEqual([]);
    expect((await putChunk(w, "delta", "two", up.uploadId, a)).status).toBe(
      204,
    );
    // Stored again: a repeat of the plan call finds it present.
    expect(
      (await planned(w, "delta", "two", up.uploadId, [a])).present,
    ).toEqual([[a.id, a.object.length]]);
    expect(
      (await putManifest(w, "delta", "two", up.uploadId, manifest)).status,
    ).toBe(204);
    expect((await finalize(w, "delta", "two", up.uploadId)).status).toBe(200);
    const res = await getChunk(w, a);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(a.object);
    await alarm(w);
    expect(w.r2.has(keyOf(w, "delta", a))).toBe(true);
  }

  it("a chunk whose delete reached the store but did not answer is missing at the next plan, and a PUT stores it again", async () => {
    const { w, a } = await interrupted(true);
    await again(w, a);
  });

  it("a chunk whose delete failed before reaching the store is missing at the next plan, and its PUT keeps the object", async () => {
    const { w, a } = await interrupted(false);
    await again(w, a);
  });
});

describe("keepRevisions releases the chunks of a pruned revision", () => {
  it("v1's own chunks go when v3 prunes it; the chunks every version shares stay referenced", async () => {
    const w = await filesWorld();
    const shared = chunkOf(1, 1000);
    const c1 = chunkOf(2, 1100);
    const c2 = chunkOf(3, 1200);
    const c3 = chunkOf(4, 1300);
    const v1 = (
      await writeChunked(w, "delta", "slot", manifestOf(1, 150), [shared, c1])
    ).done;
    const v2 = (
      await writeChunked(w, "delta", "slot", manifestOf(2, 151), [shared, c2], {
        baseVersion: v1.version,
      })
    ).done;
    // keepRevisions is 1: v1 is the revision, v2 live. v3 prunes v1.
    expect(chunkRefs(w, "delta", c1)).toBe(1);
    await writeChunked(w, "delta", "slot", manifestOf(3, 152), [shared, c3], {
      baseVersion: v2.version,
    });
    expect(chunkRefs(w, "delta", c1)).toBe(0);
    expect(chunkRefs(w, "delta", shared)).toBe(2);
    await alarm(w);
    expect(w.r2.has(keyOf(w, "delta", c1))).toBe(false);
    for (const c of [shared, c2, c3])
      expect(w.r2.has(keyOf(w, "delta", c))).toBe(true);
  });
});

describe("the collector never deletes a pinned chunk (D-7)", () => {
  it("a chunk the plan answered present survives an alarm between the plan and the finalize", async () => {
    const w = await filesWorld();
    const a = chunkOf(1, 1000);
    await writeChunked(w, "delta", "one", manifestOf(1, 150), [a]);
    await del(w, "delta", "one"); // A is unreferenced now, waiting for the alarm.
    const m2 = manifestOf(2, 151);
    const up = await beginChunks(w, "delta", "two", m2);
    const lists = await planned(w, "delta", "two", up.uploadId, [a]);
    expect(lists.present).toEqual([[a.id, a.object.length]]);
    await alarm(w);
    expect(w.r2.has(keyOf(w, "delta", a))).toBe(true);
    expect(
      rows(w, `SELECT 1 FROM chunks WHERE chunk_id = '${a.id}'`),
    ).toHaveLength(1);
    expect((await putManifest(w, "delta", "two", up.uploadId, m2)).status).toBe(
      204,
    );
    expect((await finalize(w, "delta", "two", up.uploadId)).status).toBe(200);
    expect(chunkRefs(w, "delta", a)).toBe(1);
    expect(w.r2.has(keyOf(w, "delta", a))).toBe(true);
    // Charged again from zero: manifest two and the chunk.
    expect(usageOf(w).file_bytes).toBe(151 + a.object.length);
  });

  it("a chunk stored for an open upload survives the alarm; once the upload is deleted it is collected", async () => {
    const w = await filesWorld();
    const a = chunkOf(1);
    const up = await holdUpload(w, "slot", [a]);
    await alarm(w);
    expect(w.r2.has(keyOf(w, "delta", a))).toBe(true);
    expect(
      (await call(w, "DELETE", uploadPath("delta", "slot", up.uploadId)))
        .status,
    ).toBe(204);
    await alarm(w);
    expect(w.r2.has(keyOf(w, "delta", a))).toBe(false);
    expect(rows(w, "SELECT 1 FROM chunks")).toEqual([]);
  });

  it("an expired upload's pins end with it: its chunks are collected at the same alarm, and the reservation is released", async () => {
    clock(NOW * 1000);
    const w = await filesWorld();
    const a = chunkOf(1);
    await holdUpload(w, "slot", [a]);
    clock(NOW * 1000 + DAY + 1000);
    await alarm(w);
    expect(w.r2.keys()).toEqual([]);
    expect(rows(w, "SELECT 1 FROM chunks")).toEqual([]);
    expect(rows(w, "SELECT 1 FROM upload_chunks")).toEqual([]);
    expect(usageOf(w).reserved_bytes ?? 0).toBe(0);
  });

  it("a finalize that ends in a conflict leaves its chunks unreferenced: the next alarm collects them", async () => {
    const w = await filesWorld();
    const a = chunkOf(1);
    const m = manifestOf();
    const up = await beginChunks(w, "delta", "slot", m, { baseVersion: "*" });
    await planned(w, "delta", "slot", up.uploadId, [a]);
    await putChunk(w, "delta", "slot", up.uploadId, a);
    await putManifest(w, "delta", "slot", up.uploadId, m);
    await writeChunked(w, "delta", "slot", manifestOf(9, 170), [chunkOf(7)]);
    expect((await finalize(w, "delta", "slot", up.uploadId)).status).toBe(409);
    await alarm(w);
    expect(w.r2.has(keyOf(w, "delta", a))).toBe(false);
  });

  it("a chunk stored for a session that closed meanwhile is collected too", async () => {
    const w = await filesWorld();
    const a = chunkOf(1);
    const up = await planUpload(w, "slot", [a]);
    closeSessionAfterPut(w, "slot", up.uploadId);
    expect((await putChunk(w, "delta", "slot", up.uploadId, a)).status).toBe(
      404,
    );
    await alarm(w);
    expect(w.r2.keys()).toEqual([]);
  });
});

describe("collections are isolated", () => {
  it("the same chunk id in two collections is two objects, two rows and two reference counts; deleting one collection's record leaves the other's chunk", async () => {
    const w = await filesWorld({ catalog: TWO_DELTA });
    const a = chunkOf(1);
    await writeChunked(w, "delta", "slot", manifestOf(1, 150), [a]);
    await writeChunked(w, "delta2", "slot", manifestOf(2, 151), [a]);
    expect(w.r2.has(keyOf(w, "delta", a))).toBe(true);
    expect(w.r2.has(keyOf(w, "delta2", a))).toBe(true);
    await del(w, "delta", "slot");
    await alarm(w);
    expect(w.r2.has(keyOf(w, "delta", a))).toBe(false);
    expect(w.r2.has(keyOf(w, "delta2", a))).toBe(true);
    expect(chunkRefs(w, "delta2", a)).toBe(1);
    expect(chunkRefs(w, "delta", a)).toBeUndefined();
    expect(
      (await call(w, "GET", `/${SLUG}/sync/files/delta2/chunks/${a.id}`))
        .status,
    ).toBe(200);
    expect(
      (await call(w, "GET", `/${SLUG}/sync/files/delta/chunks/${a.id}`)).status,
    ).toBe(404);
  });
});

describe("an erasure deletes the chunk prefix", () => {
  async function chunked() {
    const w = await filesWorld();
    await writeChunked(w, "delta", "one", manifestOf(1, 150), [
      chunkOf(1),
      chunkOf(2),
    ]);
    // An object that has a row nowhere: it is under the person's chunk prefix all the same.
    await w.r2.put(
      `u/${SLUG}/${w.subject}/c/delta/${"f".repeat(64)}`,
      new Uint8Array(3),
    );
    // Another person's chunk is not this person's to delete.
    const theirs = `u/${SLUG}/ps_someoneelse/c/delta/${"e".repeat(64)}`;
    await w.r2.put(theirs, new Uint8Array(3));
    return { w, theirs };
  }

  it("deleteAll removes the chunk objects, referenced or not, and strays under u/<p>/<s>/c/", async () => {
    const { w, theirs } = await chunked();
    expect(w.r2.keys().filter((k) => k.includes("/c/")).length).toBe(4);
    await deleteCloudSync(w.env, pin(w));
    expect(w.r2.keys()).toEqual([theirs]);
  });

  it("product deletion erases each person's objects through the same call, chunks included", async () => {
    const { w, theirs } = await chunked();
    await w.db.run(
      `INSERT INTO sync_directory (product, subject, bytes, settings, records, files, revision_bytes,
         quota_bytes, tier_id, platform, last_active_at, updated_at)
       VALUES (?, ?, 0, 0, 0, 0, 0, 0, NULL, NULL, 1, 1)`,
      SLUG,
      w.subject,
    );
    const out = await syncProductPurge({
      db: w.db,
      env: w.env,
      product: SLUG,
      now: NOW,
    });
    expect(out).toEqual({ done: true });
    expect(w.r2.keys()).toEqual([theirs]);
  });

  it("an erasure removes chunk objects by the prefix sweep, a page at a time, without reading every chunk row", async () => {
    const { w } = await chunked();
    // More chunk objects than one page of the sweep.
    for (let i = 0; i < 1500; i++)
      await w.r2.put(
        `u/${SLUG}/${w.subject}/c/delta/${i.toString(16).padStart(64, "0")}`,
        new Uint8Array(3),
      );
    const allChunks = vi.spyOn(SqlStore.prototype, "allChunks");
    const lists = vi.spyOn(w.r2, "list");
    // The keys are gone before the first call to R2.
    let keysAtFirstCall: number | undefined;
    const realList = w.r2.list.bind(w.r2);
    w.r2.list = ((...args: Parameters<typeof realList>) => {
      keysAtFirstCall ??= rows(w, "SELECT kid FROM ssec_keys").length;
      return realList(...args);
    }) as typeof w.r2.list;
    await deleteCloudSync(w.env, pin(w));
    expect(allChunks).not.toHaveBeenCalled();
    expect(lists.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(keysAtFirstCall).toBe(0);
    expect(w.r2.keys().some((k) => k.includes(`/${w.subject}/`))).toBe(false);
    allChunks.mockRestore();
  });

  it("if R2 fails the erasure is refused and the chunk rows are kept for a retry", async () => {
    const { w } = await chunked();
    const realList = w.r2.list.bind(w.r2);
    w.r2.list = () => Promise.reject(new Error("r2 down"));
    await expect(deleteCloudSync(w.env, pin(w))).rejects.toThrow();
    expect(rows(w, "SELECT 1 FROM chunks")).toHaveLength(2);
    w.r2.list = realList;
    await deleteCloudSync(w.env, pin(w));
    expect(w.r2.keys().some((k) => k.includes(`/${w.subject}/`))).toBe(false);
  });
});

describe("export and absorb carry chunks", () => {
  async function pair() {
    const w = await filesWorld();
    const a = chunkOf(1, 1000);
    const b = chunkOf(2, 2000);
    await writeChunked(w, "delta", "slot", manifestOf(1, 150), [a, b]);
    // A chunk nothing references: it does not move.
    const loose = chunkOf(3, 500);
    const up = await holdUpload(w, "tmp", [loose], manifestOf(2, 151));
    await call(w, "DELETE", uploadPath("delta", "tmp", up.uploadId));
    const { alice, bob } = await survivorOf(w);
    return { w, alice, bob, a, b, loose };
  }
  const bobDb = (w: FilesWorld, bob: { subject: string }) =>
    w.ns.instances.get(`${SLUG}:${bob.subject}`)!.storage.sql.db;

  it("a person's own export counts the chunks without keys; a merge export adds keys and the file-to-chunk rows, and not the loose chunk", async () => {
    const { w, alice, a, b } = await pair();
    const own = await exportCloudSync(w.env, alice);
    expect(own?.chunks).toEqual(
      [
        {
          collection: "delta",
          chunkId: a.id,
          storedBytes: a.object.length,
          refs: 1,
        },
        {
          collection: "delta",
          chunkId: b.id,
          storedBytes: b.object.length,
          refs: 1,
        },
      ].sort((x, y) => (x.chunkId < y.chunkId ? -1 : 1)),
    );
    expect(own?.fileChunks).toBeUndefined();
    expect(JSON.stringify(own)).not.toMatch(/objectKey|u\/djdl\//);
    const merge = await exportCloudSync(w.env, alice, { forMerge: true });
    expect(merge?.chunks?.every((c) => typeof c.objectKey === "string")).toBe(
      true,
    );
    expect(merge?.fileChunks).toHaveLength(2);
  });

  it("the survivor takes the chunks with their keys, serves them, and absorbing again changes nothing; its erasure sweeps the absorbed prefix", async () => {
    const { w, alice, bob, a, b } = await pair();
    const doc = (await exportCloudSync(w.env, alice, { forMerge: true }))!;
    expect((await absorbCloudSync(w.env, bob, doc)).changed).toBeGreaterThan(0);
    const chunks = bobDb(w, bob)
      .prepare(
        "SELECT chunk_id, refs, object_key FROM chunks ORDER BY chunk_id",
      )
      .all() as { chunk_id: string; refs: number; object_key: string }[];
    expect(chunks.map((c) => [c.chunk_id, c.refs])).toEqual(
      [
        [a.id, 1],
        [b.id, 1],
      ].sort((x, y) => (x[0]! < y[0]! ? -1 : 1)),
    );
    for (const c of chunks) expect(c.object_key).toContain(alice.subject);
    const res = await call(
      w,
      "GET",
      `/${SLUG}/sync/files/delta/chunks/${a.id}`,
    );
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(a.object);
    expect((await absorbCloudSync(w.env, bob, doc)).changed).toBe(0);
    expect(
      bobDb(w, bob).prepare("SELECT COUNT(*) AS n FROM file_chunks").get(),
    ).toEqual({ n: 2 });
    // The merged-away object's delete keeps what moved and clears the loose chunk.
    expect(
      await deleteCloudSyncIfUnchanged(
        w.env,
        alice,
        { seq: doc.seq, writes: doc.writes },
        bob.subject,
      ),
    ).toBe(true);
    expect(w.r2.keys().filter((k) => k.includes("/c/"))).toHaveLength(2);
    await deleteCloudSync(w.env, bob);
    expect(w.r2.keys()).toEqual([]);
  });

  it("a merge takes the absorbed chunk row over a survivor row whose delete was attempted", async () => {
    const { w, alice, bob, a } = await pair();
    bobDb(w, bob)
      .prepare(
        `INSERT INTO chunks (collection, chunk_id, object_key, stored_bytes, refs, unref_at)
         VALUES ('delta', ?, ?, ?, 0, -1)`,
      )
      .run(a.id, `u/${SLUG}/${bob.subject}/c/delta/${a.id}`, a.object.length);
    const doc = (await exportCloudSync(w.env, alice, { forMerge: true }))!;
    await absorbCloudSync(w.env, bob, doc);
    const row = bobDb(w, bob)
      .prepare(
        "SELECT object_key, refs, unref_at FROM chunks WHERE chunk_id = ?",
      )
      .get(a.id) as { object_key: string; refs: number; unref_at: number };
    expect(row.object_key).toContain(alice.subject);
    expect(row.refs).toBe(1);
    expect(row.unref_at).not.toBe(-1);
    const res = await call(
      w,
      "GET",
      `/${SLUG}/sync/files/delta/chunks/${a.id}`,
    );
    expect(res.status).toBe(200);
  });

  it("the survivor charges the chunks it took, once", async () => {
    const { w, alice, bob, a, b } = await pair();
    const doc = (await exportCloudSync(w.env, alice, { forMerge: true }))!;
    await absorbCloudSync(w.env, bob, doc);
    const used = bobDb(w, bob)
      .prepare("SELECT value FROM meta WHERE key = 'usage_file_bytes'")
      .get() as { value: string };
    expect(Number(used.value)).toBe(150 + a.object.length + b.object.length);
  });

  it("a malformed chunk in an export is refused whole, before any write", async () => {
    const { w, alice, bob } = await pair();
    const doc = (await exportCloudSync(w.env, alice, { forMerge: true }))!;
    const c0 = doc.chunks![0]!;
    const bad = [
      {
        ...doc,
        chunks: [
          { ...c0, objectKey: "u/other/ps_x/c/delta/" + c0.chunkId },
          ...doc.chunks!.slice(1),
        ],
      },
      {
        ...doc,
        chunks: [{ ...c0, objectKey: "../../etc" }, ...doc.chunks!.slice(1)],
      },
      { ...doc, chunks: [{ ...c0, chunkId: "zz" }, ...doc.chunks!.slice(1)] },
      { ...doc, chunks: [{ ...c0, storedBytes: 0 }, ...doc.chunks!.slice(1)] },
      { ...doc, chunks: doc.chunks!.slice(1) },
      { ...doc, fileChunks: [{ ...doc.fileChunks![0]!, version: 999 }] },
    ];
    for (const d of bad)
      await expect(absorbCloudSync(w.env, bob, d as never)).rejects.toThrow();
    expect(
      bobDb(w, bob).prepare("SELECT COUNT(*) AS n FROM chunks").get(),
    ).toEqual({ n: 0 });
  });
});
