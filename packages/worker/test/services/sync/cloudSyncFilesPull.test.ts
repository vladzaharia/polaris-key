/**
 * U-10.9: files on records in the engine (WIRE-CONTRACT-V5 §13.3, §13.4, §13.8.1; GF1, GF4), over
 * the in-memory store: the `file` pointer on a pull change and on a conflict copy, the shape of a
 * record that has a file and no value, `usage.files`, the record `delete` that retires its file and
 * every kept revision (and gives the quota back), and `keepRevisions` at `finalize`.
 * `cloudSyncSqlParityFilesPull.test.ts` replays this file over the Durable Object's SQLite store.
 */
import { describe, expect, it } from "vitest";
import type { SyncMutation } from "@polaris-key/protocol/sync";
import { MemoryStore } from "../../../src/services/sync/engine/memoryStore.js";
import {
  commitFinalize,
  commitBegin,
} from "../../../src/services/sync/engine/files.js";
import type {
  UploadRow,
  SyncStore,
} from "../../../src/services/sync/engine/types.js";
import { fileUsage } from "../../../src/services/sync/engine/usage.js";
import {
  NOW,
  ago,
  applyAll,
  applyOk,
  blinded,
  pullAs as pull,
  recordOp,
  recordRoute,
  restartIds,
  sealedBox,
} from "./cloudSyncRecordsHarness.js";

const sha = (n: number) => n.toString(16).padStart(64, "0");

let uploadIds = 0;

/** A `finalize`d file on a record, the way the route commits it. */
function finalized(
  store: SyncStore,
  record: [string, string],
  size: number,
  opts: { keep?: number; baseVersion?: number | "*" | null; sha?: string } = {},
) {
  const upload: UploadRow = {
    uploadId: `up_${++uploadIds}`,
    collection: record[0],
    recordId: record[1],
    baseVersion: opts.baseVersion === undefined ? null : opts.baseVersion,
    mode: "single",
    format: "whole",
    enc: "none",
    size,
    sha256: opts.sha ?? sha(size),
    partBytes: null,
    multipartId: null,
    reservedBytes: size,
    deviceId: "dev1",
    createdAt: NOW,
    expiresAt: NOW + 86_400_000,
    state: "finalizing",
    resultJson: null,
  };
  commitBegin(store, upload);
  const out = commitFinalize(store, {
    upload,
    objectKey: `u/p/s/o/${upload.uploadId}`,
    clientId: "c_aaaaaaaaaaaaaaaaaaaaaa",
    maxRecords: 100,
    keepRevisions: opts.keep ?? 5,
    nowMs: NOW,
  });
  if (!out.ok) throw new Error(JSON.stringify(out));
  return out.result;
}

const set = (record: [string, string], value: unknown, extra = {}) =>
  [
    recordOp(record[0], record[1], "set", {
      value: value as SyncMutation["value"],
      editedHlc: ago(500),
      ...extra,
    }),
    recordRoute("revision"),
  ] as const;

describe("the file pointer on a pull change (GF1)", () => {
  it("a record with a value and a file carries both; the pointer is the file's own version", () => {
    restartIds();
    const store = new MemoryStore();
    applyOk(store, set(["saves", "s1"], { chapter: 1 }, { baseVersion: "*" }));
    const file = finalized(store, ["saves", "s1"], 1234, { baseVersion: null });
    const out = pull(store);
    expect(out.changes).toEqual([
      {
        record: ["saves", "s1"],
        value: { chapter: 1 },
        version: file.version,
        editedHlc: expect.any(String),
        file: {
          version: file.version,
          size: 1234,
          sha256: sha(1234),
          format: "whole",
        },
      },
    ]);
  });

  it("a later metadata write moves the record's version and leaves the pointer where it was", () => {
    restartIds();
    const store = new MemoryStore();
    const file = finalized(store, ["saves", "s1"], 50, { baseVersion: "*" });
    applyOk(
      store,
      set(["saves", "s1"], { chapter: 2 }, { baseVersion: file.version }),
    );
    const [change] = pull(store).changes;
    expect(change).toMatchObject({
      record: ["saves", "s1"],
      value: { chapter: 2 },
      file: { version: file.version, size: 50 },
    });
    expect((change as { version: number }).version).toBeGreaterThan(
      file.version,
    );
  });

  it("a record with a file and no value carries neither value nor ct: {record, version, editedHlc, file}", () => {
    restartIds();
    const store = new MemoryStore();
    const file = finalized(store, ["saves", "s1"], 77, { baseVersion: "*" });
    const [change] = pull(store).changes;
    expect(change).toEqual({
      record: ["saves", "s1"],
      version: file.version,
      editedHlc: expect.any(String),
      file: {
        version: file.version,
        size: 77,
        sha256: sha(77),
        format: "whole",
      },
    });
    expect(Object.keys(change as object)).not.toContain("value");
    expect(Object.keys(change as object)).not.toContain("ct");
  });

  it("end-to-end: a sealed value keeps its ct beside the pointer, and a file-only record has no ct", () => {
    restartIds();
    const store = new MemoryStore();
    const id = blinded(1);
    const file = finalized(store, ["saves", id], 10, { baseVersion: "*" });
    applyOk(store, [
      recordOp("saves", id, "set", {
        ct: sealedBox(),
        editedHlc: ago(10),
        baseVersion: file.version,
      }),
      recordRoute("revision", { sealed: true }),
    ]);
    const other = blinded(2);
    const lone = finalized(store, ["saves", other], 20, { baseVersion: "*" });
    const out = pull(store, { e2e: true });
    expect(out.changes).toEqual([
      {
        record: ["saves", id],
        ct: sealedBox(),
        version: expect.any(Number),
        editedHlc: expect.any(String),
        file: expect.objectContaining({ version: file.version, size: 10 }),
      },
      {
        record: ["saves", other],
        version: lone.version,
        editedHlc: expect.any(String),
        file: expect.objectContaining({ version: lone.version, size: 20 }),
      },
    ]);
  });

  it("a record with no file carries no pointer, and a tombstone never does", () => {
    restartIds();
    const store = new MemoryStore();
    applyOk(
      store,
      set(["saves", "plain"], 1, { baseVersion: "*" }),
      set(["saves", "gone"], 2, { baseVersion: "*" }),
    );
    finalized(store, ["saves", "other"], 5, { baseVersion: "*" });
    applyOk(store, [
      recordOp("saves", "gone", "delete", { editedHlc: ago(100) }),
      recordRoute("revision"),
    ]);
    const out = pull(store);
    const plain = out.changes.find(
      (c) => "record" in c && c.record[1] === "plain",
    );
    expect(plain).toBeDefined();
    expect(Object.keys(plain as object)).not.toContain("file");
    expect(out.tombstones).toEqual([
      { record: ["saves", "gone"], editedHlc: expect.any(String) },
    ]);
  });

  it("usage.files counts the records' live files, not their revisions", () => {
    restartIds();
    const store = new MemoryStore();
    expect(pull(store).usage.files).toBe(0);
    finalized(store, ["saves", "a"], 10, { baseVersion: "*" });
    finalized(store, ["saves", "a"], 20);
    finalized(store, ["saves", "b"], 30, { baseVersion: "*" });
    const out = pull(store);
    expect(out.usage.files).toBe(2);
    expect(out.usage.records).toBe(2);
    expect(out.usage.bytes).toBeGreaterThanOrEqual(10 + 20 + 30);
  });

  it("a store with files is not empty at cursor 0", () => {
    restartIds();
    const store = new MemoryStore();
    expect(pull(store).empty).toBe(true);
    finalized(store, ["saves", "a"], 10, { baseVersion: "*" });
    expect(pull(store).empty).toBeUndefined();
  });
});

describe("the file pointer on a conflict copy (GF1)", () => {
  const conflictOf = (store: MemoryStore, mutation: SyncMutation) => {
    const [r] = applyAll(store, [[mutation, recordRoute("revision")]]);
    if (r?.status !== "conflict") throw new Error(JSON.stringify(r));
    return r.server;
  };

  it("carries the pointer beside the value", () => {
    restartIds();
    const store = new MemoryStore();
    applyOk(store, set(["saves", "s1"], { n: 1 }, { baseVersion: "*" }));
    const file = finalized(store, ["saves", "s1"], 9);
    const server = conflictOf(
      store,
      recordOp("saves", "s1", "set", { value: { n: 2 }, baseVersion: 1 }),
    );
    expect(server).toMatchObject({
      value: { n: 1 },
      version: file.version,
      file: { version: file.version, size: 9, sha256: sha(9), format: "whole" },
    });
  });

  it("a file-only record's copy has neither value nor ct", () => {
    restartIds();
    const store = new MemoryStore();
    const file = finalized(store, ["saves", "s1"], 9, { baseVersion: "*" });
    const server = conflictOf(
      store,
      recordOp("saves", "s1", "set", { value: { n: 2 }, baseVersion: 99 }),
    );
    expect(server).toEqual({
      version: file.version,
      editedHlc: expect.any(String),
      file: expect.objectContaining({ version: file.version }),
    });
  });

  it("a record without a file has a copy without a pointer", () => {
    restartIds();
    const store = new MemoryStore();
    applyOk(store, set(["saves", "s1"], { n: 1 }, { baseVersion: "*" }));
    const server = conflictOf(
      store,
      recordOp("saves", "s1", "set", { value: { n: 2 }, baseVersion: 99 }),
    );
    expect(Object.keys(server)).not.toContain("file");
  });
});

describe("a record delete removes its file and every revision (GF4)", () => {
  const del = (store: MemoryStore, id: string, extra = {}) =>
    applyOk(store, [
      recordOp("saves", id, "delete", { editedHlc: ago(50), ...extra }),
      recordRoute("revision"),
    ]);

  it("retires the live file and the revisions, and gives the quota back at once", () => {
    restartIds();
    const store = new MemoryStore();
    finalized(store, ["saves", "s1"], 1000, { baseVersion: "*" });
    finalized(store, ["saves", "s1"], 2000);
    finalized(store, ["saves", "s1"], 3000);
    const before = store.getUsage();
    expect(fileUsage(before)).toMatchObject({
      files: 1,
      fileBytes: 3000,
      revisionBytes: 3000,
    });
    del(store, "s1");
    expect(store.filesOf("saves", "s1").map((f) => [f.size, f.status])).toEqual(
      [
        [1000, "dead"],
        [2000, "dead"],
        [3000, "dead"],
      ],
    );
    const after = store.getUsage();
    expect(fileUsage(after)).toMatchObject({
      files: 0,
      fileBytes: 0,
      revisionBytes: 0,
    });
    expect(after.bytes).toBe(before.bytes - 6000 - before.recordBytes);
    expect(store.liveFile("saves", "s1")).toBeUndefined();
    expect(pull(store).changes).toEqual([]);
    expect(pull(store).usage.files).toBe(0);
  });

  it("leaves another record's files, and a record with no file, alone", () => {
    restartIds();
    const store = new MemoryStore();
    finalized(store, ["saves", "keep"], 10, { baseVersion: "*" });
    finalized(store, ["saves", "keep"], 11);
    applyOk(store, set(["saves", "plain"], 1, { baseVersion: "*" }));
    del(store, "plain");
    expect(store.filesOf("saves", "keep").map((f) => f.status)).toEqual([
      "revision",
      "live",
    ]);
    expect(store.filesWithStatus("dead", 10)).toEqual([]);
    expect(fileUsage(store.getUsage())).toMatchObject({ files: 1 });
  });

  it("a parked copy's file is not the record's: it survives the record's delete", () => {
    restartIds();
    const store = new MemoryStore();
    finalized(store, ["saves", "s1"], 10, { baseVersion: "*" });
    store.putFile({
      ...store.filesOf("saves", "s1")[0]!,
      version: 9999,
      objectKey: "u/p/other/o/up_parked",
      status: "parked",
    });
    del(store, "s1");
    expect(
      store.filesOf("saves", "s1").map((f) => [f.version, f.status]),
    ).toEqual([
      [expect.any(Number), "dead"],
      [9999, "parked"],
    ]);
  });

  it("a delete refused as a conflict keeps the file", () => {
    restartIds();
    const store = new MemoryStore();
    finalized(store, ["saves", "s1"], 10, { baseVersion: "*" });
    const [r] = applyAll(store, [
      [
        recordOp("saves", "s1", "delete", { baseVersion: 12345 }),
        recordRoute("revision"),
      ],
    ]);
    expect(r?.status).toBe("conflict");
    expect(store.liveFile("saves", "s1")?.status).toBe("live");
    expect(store.filesWithStatus("dead", 10)).toEqual([]);
  });

  it("deleting twice retires once: the counters do not go below what is held", () => {
    restartIds();
    const store = new MemoryStore();
    finalized(store, ["saves", "s1"], 10, { baseVersion: "*" });
    finalized(store, ["saves", "x"], 500, { baseVersion: "*" });
    del(store, "s1");
    del(store, "s1");
    expect(fileUsage(store.getUsage())).toMatchObject({
      files: 1,
      fileBytes: 500,
    });
  });

  it("a record created again after the delete starts with no file", () => {
    restartIds();
    const store = new MemoryStore();
    finalized(store, ["saves", "s1"], 10, { baseVersion: "*" });
    del(store, "s1");
    applyOk(store, set(["saves", "s1"], { n: 1 }));
    const [change] = pull(store).changes;
    expect(Object.keys(change as object)).not.toContain("file");
    expect(store.liveFile("saves", "s1")).toBeUndefined();
  });
});

describe("keepRevisions at finalize", () => {
  const statuses = (store: MemoryStore) =>
    store.filesOf("saves", "s1").map((f) => `${f.size}:${f.status}`);

  it("keeps the newest N older versions and retires the rest, bytes freed", () => {
    restartIds();
    const store = new MemoryStore();
    finalized(store, ["saves", "s1"], 1, { baseVersion: "*", keep: 2 });
    for (const size of [2, 3, 4, 5])
      finalized(store, ["saves", "s1"], size, { keep: 2 });
    expect(statuses(store)).toEqual([
      "1:dead",
      "2:dead",
      "3:revision",
      "4:revision",
      "5:live",
    ]);
    expect(fileUsage(store.getUsage())).toMatchObject({
      files: 1,
      fileBytes: 5,
      revisionBytes: 7,
    });
  });

  it("keepRevisions 0 keeps no older version: the replaced file dies at once", () => {
    restartIds();
    const store = new MemoryStore();
    finalized(store, ["saves", "s1"], 1, { baseVersion: "*", keep: 0 });
    finalized(store, ["saves", "s1"], 2, { keep: 0 });
    expect(statuses(store)).toEqual(["1:dead", "2:live"]);
    expect(fileUsage(store.getUsage())).toMatchObject({
      fileBytes: 2,
      revisionBytes: 0,
    });
  });

  it("never retires the live file, however low the count", () => {
    restartIds();
    const store = new MemoryStore();
    for (const size of [1, 2, 3])
      finalized(store, ["saves", "s1"], size, { keep: 0 });
    expect(store.liveFile("saves", "s1")?.size).toBe(3);
  });
});
