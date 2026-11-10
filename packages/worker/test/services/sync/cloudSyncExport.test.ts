/**
 * U-12.4: Cloud Sync's part of a person's export. The JSON section is bounded (records inline only
 * while small, file metadata up to a row count); the zip carries every record, live file, kept
 * revision and chunk container. Server mode opens files through the person's SSE-C key, end-to-end
 * mode hands out the stored ciphertext, and another person's data is never in either.
 */
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runSubjectExport } from "../../../src/core/accounts/subjectHooks.js";
import {
  deleteCloudSyncIfUnchanged,
  exportCloudSync,
} from "../../../src/services/sync/do/client.js";
import { cloudSyncStore } from "../../../src/services/sync/subjectStore.js";
import {
  INLINE_FILES_ROWS,
  MAX_EXPORT_SUBREQUESTS,
  INLINE_RECORDS_BYTES,
} from "../../../src/services/sync/exportSection.js";
import { zipStream } from "../../../src/platform/zipStream.js";
import { NOW } from "../../seed.js";
import { installDigestStream } from "../../r2Mock.js";
import {
  SLUG,
  becomeBob,
  bytesOf,
  filesWorld,
  push,
  setQuota,
  stored,
  type FilesWorld,
} from "./cloudSyncFilesWorld.js";
import { hlc, nextId } from "./cloudSyncAbuseWorld.js";
import {
  chunkOf,
  exec,
  manifestOf,
  writeChunked,
} from "./cloudSyncChunksWorld.js";

beforeAll(() => installDigestStream());

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const ctx = (w: FilesWorld) => ({ db: w.db, env: w.env, now: NOW });
const who = (w: FilesWorld) => ({ product: SLUG, subject: w.subject });

const section = async (w: FilesWorld) =>
  (await cloudSyncStore.export!(ctx(w), who(w))) as Record<string, any>;

/** The store's entries written as a zip, opened with the system unzip: name to bytes. */
async function archive(w: FilesWorld): Promise<Map<string, Buffer>> {
  const entries = await cloudSyncStore.exportEntries!(ctx(w), who(w));
  const stream = zipStream(entries);
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  const dir = mkdtempSync(join(tmpdir(), "pkey-sync-export-"));
  dirs.push(dir);
  const file = join(dir, "x.zip");
  writeFileSync(file, bytes);
  execFileSync("unzip", ["-tq", file]);
  execFileSync("unzip", ["-qo", file, "-d", join(dir, "out")]);
  const out = new Map<string, Buffer>();
  const walk = (rel: string) => {
    for (const e of readdirSync(join(dir, "out", rel), {
      withFileTypes: true,
    })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p);
      else out.set(p, readFileSync(join(dir, "out", p)));
    }
  };
  walk("");
  return out;
}

/** What the export asks R2 for from now on: each object's key and the SSE-C key it presents. */
function recordGets(w: FilesWorld): Array<{ key: string; ssecKey?: string }> {
  const reads: Array<{ key: string; ssecKey?: string }> = [];
  const get = w.r2.get.bind(w.r2);
  w.r2.get = ((key: string, opts?: { ssecKey?: string }) => {
    reads.push({ key, ssecKey: opts?.ssecKey });
    return get(key, opts as never);
  }) as never;
  return reads;
}

const text = (m: Map<string, Buffer>, name: string): string =>
  m.get(name)!.toString("utf8");
const jsonOf = (m: Map<string, Buffer>, name: string) =>
  JSON.parse(text(m, name));

const setRecord = (id: string, value: unknown, collection = "big") => ({
  mutationId: nextId(),
  target: { record: [collection, id] as [string, string] },
  op: "set" as const,
  value: value as never,
  editedHlc: hlc,
});

/** Rows straight into the object, to get past what a push may carry (a store over the bound). */
function bulkRecords(w: FilesWorld, n: number, bytes: number): void {
  const value = JSON.stringify("x".repeat(bytes));
  for (let i = 0; i < n; i++)
    exec(
      w,
      `INSERT INTO records (collection, id, version, hlc, client_id, value_json, kind, deleted)
       VALUES ('big', 'bulk-${i}', ${10_000 + i}, '${hlc}', 'c', '${value}', 'value', 0)`,
    );
}

describe("the bounded JSON section", () => {
  it("a person with no object has no section", async () => {
    const w = await filesWorld();
    expect(await section(w)).toMatchObject({ settings: null, directory: null });
  });

  it("a small store is inline: records, tombstones, file metadata, clients; no key or R2 path", async () => {
    const w = await filesWorld();
    await push(w, [
      setRecord("a", { n: 1 }),
      setRecord("b", { n: 2 }),
      {
        mutationId: nextId(),
        target: { setting: "volume", scope: "user" },
        op: "set",
        value: 3,
        editedHlc: hlc,
      },
    ]);
    await push(w, [
      {
        mutationId: nextId(),
        target: { record: ["big", "b"] },
        op: "delete",
        editedHlc: hlc,
      },
    ]);
    await stored(w, "saves", "s1", bytesOf(300));
    const s = await section(w);
    expect(s.encryption).toBe("server");
    expect(s.settings.map((r: { key: string }) => r.key)).toEqual(["volume"]);
    expect(
      s.records.map((r: { id: string; deleted: boolean }) => [r.id, r.deleted]),
    ).toEqual([
      ["a", false],
      ["b", true],
      // A file lives on a record.
      ["s1", false],
    ]);
    expect(s.recordsIn).toBeUndefined();
    expect(s.fileCount).toBe(1);
    expect(s.files).toHaveLength(1);
    expect(s.files[0]).toMatchObject({ collection: "saves", size: 300 });
    expect(s.clients).toEqual([
      expect.objectContaining({
        clientId: expect.any(String),
        deviceId: "dev-attack-1",
        lastSeen: expect.any(Number),
      }),
    ]);
    expect(s.clients[0]).not.toHaveProperty("lastMutationId");
    const all = JSON.stringify(s);
    expect(all).not.toContain("objectKey");
    expect(all).not.toContain("ssec");
    expect(all).not.toContain("u/");
  });

  it("a store over 4 MiB omits its records from the JSON and says where they are", async () => {
    const w = await filesWorld();
    await push(w, [setRecord("first", { n: 1 })]);
    bulkRecords(w, 50, 100_000);
    const s = await section(w);
    expect(s.recordsIn).toBe("zip");
    expect(s.records).toBeUndefined();
    expect(JSON.stringify(s).length).toBeLessThan(INLINE_RECORDS_BYTES);
    expect(
      s.collections.find((c: { name: string }) => c.name === "big"),
    ).toBeTruthy();
  });

  it("more than 2,000 files keep their metadata out of the JSON", async () => {
    const w = await filesWorld();
    await stored(w, "saves", "s1", bytesOf(10));
    // Make the count exceed the bound without storing 2,000 objects: clone the row.
    exec(
      w,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${INLINE_FILES_ROWS})
       INSERT INTO files SELECT collection, 'c' || i, version, object_key, format, enc, size, sha256,
         'live', ssec_kid, created_at, client_id FROM files, n WHERE record_id = 's1'`,
    );
    const s = await section(w);
    expect(s.fileCount).toBe(INLINE_FILES_ROWS + 1);
    expect(s.filesIn).toBe("zip");
    expect(s.files).toBeUndefined();
  });
});

describe("the zip entries", () => {
  it("carries every record, tombstone, live file, revision and chunk container", async () => {
    const w = await filesWorld();
    await setQuota(w, 50_000_000);
    await push(w, [setRecord("a", { n: 1 }), setRecord("b", { n: 2 })]);
    await push(w, [
      {
        mutationId: nextId(),
        target: { record: ["big", "b"] },
        op: "delete",
        editedHlc: hlc,
      },
    ]);
    const first = bytesOf(400, 1);
    const second = bytesOf(500, 2);
    await stored(w, "saves", "s1", first, { baseVersion: "*" });
    await stored(w, "saves", "s1", second);
    const manifest = manifestOf(3);
    const k1 = chunkOf(11, 2000);
    const k2 = chunkOf(12, 3000);
    await writeChunked(w, "delta", "d1", manifest, [k1, k2]);

    const m = await archive(w);
    const names = [...m.keys()].sort();
    expect(names).toEqual([
      "chunks.json",
      "chunks/0.bin",
      "files.json",
      "files/1.bin",
      "files/2.bin",
      "files/3.bin",
      "index.json",
      "records/0.ndjson",
      "records/1.ndjson",
      "records/2.ndjson",
    ]);
    const index = jsonOf(m, "index.json");
    expect(index.records).toEqual([
      { collection: "big", entry: "records/0.ndjson" },
      { collection: "delta", entry: "records/1.ndjson" },
      { collection: "saves", entry: "records/2.ndjson" },
    ]);
    const lines = text(m, "records/0.ndjson")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.map((r) => [r.id, r.deleted])).toEqual([
      ["a", false],
      ["b", true],
    ]);

    // The files: the live one and the kept revision (and the delta file's manifest), as stored.
    const files = jsonOf(m, "files.json") as Array<{
      entry: string;
      collection: string;
      status: string;
      size: number;
    }>;
    expect(files.map((f) => [f.collection, f.status, f.size])).toEqual([
      ["delta", "live", manifest.length],
      ["saves", "revision", 400],
      ["saves", "live", 500],
    ]);
    const byEntry = (e: string) => m.get(e)!;
    expect(byEntry(files[1]!.entry)).toEqual(Buffer.from(first));
    expect(byEntry(files[2]!.entry)).toEqual(Buffer.from(second));

    // The chunks, back to back, with the offset of each.
    const chunks = jsonOf(m, "chunks.json") as Array<{
      collection: string;
      entry: string;
      chunks: Array<{ chunkId: string; offset: number; size: number }>;
    }>;
    expect(chunks).toHaveLength(1);
    const container = m.get("chunks/0.bin")!;
    expect(chunks[0]!.chunks.map((c) => c.chunkId).sort()).toEqual(
      [k1.id, k2.id].sort(),
    );
    for (const c of chunks[0]!.chunks) {
      const want = [k1, k2].find((k) => k.id === c.chunkId)!.object;
      expect(container.subarray(c.offset, c.offset + c.size)).toEqual(
        Buffer.from(want),
      );
    }
    expect(container.length).toBe(k1.object.length + k2.object.length);
  });

  it("server mode opens files through the person's SSE-C key", async () => {
    const w = await filesWorld();
    const bytes = bytesOf(777, 5);
    await stored(w, "saves", "s1", bytes);
    const reads = recordGets(w);
    const m = await archive(w);
    expect(m.get("files/1.bin")).toEqual(Buffer.from(bytes));
    expect(reads).toHaveLength(1);
    expect(reads[0]!.ssecKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("end to end, a file comes out as the ciphertext that was stored", async () => {
    const w = await filesWorld({
      catalog: {
        schemaVersion: 1,
        entries: [],
        cloudSync: { collections: [{ name: "saves", template: "saves" }] },
      },
    });
    const sealed = bytesOf(640, 9);
    await stored(w, "saves", `x:${"A".repeat(43)}`, sealed, { enc: "e2e" });
    const reads = recordGets(w);
    const m = await archive(w);
    expect(m.get("files/1.bin")).toEqual(Buffer.from(sealed));
    expect(reads.map((r) => r.ssecKey)).toEqual([undefined]);
    // The id the app blinded is data, not a name: entries are indexes.
    expect(
      [...m.keys()].every((n) => !n.includes("x:") && !n.includes("AAAA")),
    ).toBe(true);
  });

  it("another person's records, files, keys and chunks are never listed or read", async () => {
    const w = await filesWorld();
    await push(w, [setRecord("alice-1", { who: "alice" })]);
    await stored(w, "saves", "alice-save", bytesOf(100, 1));
    const alice = who(w);
    const aliceZip = await archive(w);

    await becomeBob(w);
    await push(w, [setRecord("bob-1", { who: "bob" })]);
    await stored(w, "saves", "bob-save", bytesOf(120, 2));
    const bobKeys = new Set(
      w.r2.keys().filter((k) => !k.includes(alice.subject)),
    );
    expect(bobKeys.size).toBeGreaterThan(0);
    const reads = recordGets(w);

    // Alice's export, asked for again while Bob's data sits beside it: hers only.
    const again = new Uint8Array(
      await new Response(
        zipStream(await cloudSyncStore.exportEntries!(ctx(w), alice)),
      ).arrayBuffer(),
    );
    expect(Buffer.from(again).includes(Buffer.from("bob"))).toBe(false);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((r) => r.key.includes(alice.subject))).toBe(true);
    expect(reads.some((r) => bobKeys.has(r.key))).toBe(false);
    expect(text(aliceZip, "records/0.ndjson")).toContain("alice-1");
    expect(text(aliceZip, "records/0.ndjson")).not.toContain("bob-1");
    // The JSON section is the pinned pair's too.
    const json = JSON.stringify(await cloudSyncStore.export!(ctx(w), alice));
    expect(json).not.toContain("bob");
  });

  it("reads records in pages: 1,200 rows come out whole, once each", async () => {
    const w = await filesWorld();
    await push(w, [setRecord("first", 1)]);
    bulkRecords(w, 1200, 10);
    const m = await archive(w);
    const ids = text(m, "records/0.ndjson")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).id);
    expect(ids).toHaveLength(1201);
    expect(new Set(ids).size).toBe(1201);
  });

  it("a pair the object does not hold has no entries, and a page request is bounded", async () => {
    const w = await filesWorld();
    await push(w, [setRecord("a", 1)]);
    const other = { product: SLUG, subject: "ps_someoneElse" };
    expect(await cloudSyncStore.exportEntries!(ctx(w), other)).toEqual([]);
    const { exportPageCloudSync } =
      await import("../../../src/services/sync/do/client.js");
    await expect(
      exportPageCloudSync(w.env, who(w), {
        part: "records",
        collection: "big",
        after: 0,
        limit: 501,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("the account export (runSubjectExport, what /api/me/export calls) stays bounded", async () => {
    const w = await filesWorld();
    await push(w, [setRecord("first", 1)]);
    bulkRecords(w, 50, 100_000);
    const all = await runSubjectExport(ctx(w), who(w));
    const sync = all["sync.cloudSync"] as Record<string, unknown>;
    expect(sync.recordsIn).toBe("zip");
    expect(JSON.stringify(all).length).toBeLessThan(INLINE_RECORDS_BYTES);
  });

  it("an object that goes away mid-export stops the stream instead of finishing short", async () => {
    const w = await filesWorld();
    await push(w, [setRecord("a", 1)]);
    bulkRecords(w, 3, 10);
    const entries = await cloudSyncStore.exportEntries!(ctx(w), who(w));
    // Absorbed between the listing and the streaming.
    await deleteCloudSyncIfUnchanged(
      w.env,
      who(w),
      {
        seq: (await exportCloudSync(w.env, who(w)))!.seq,
        writes: (await exportCloudSync(w.env, who(w)))!.writes,
      },
      "ps_survivor",
    );
    await expect(
      new Response(zipStream(entries)).arrayBuffer(),
    ).rejects.toThrow();
  });

  it("refuses a zip over the subrequest budget up front", async () => {
    const w = await filesWorld();
    await stored(w, "saves", "s1", bytesOf(10));
    exec(
      w,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${MAX_EXPORT_SUBREQUESTS / 2})
       INSERT INTO files SELECT collection, 'c' || i, version, object_key, format, enc, size, sha256,
         'live', ssec_kid, created_at, client_id FROM files, n WHERE record_id = 's1'`,
    );
    await expect(
      cloudSyncStore.exportEntries!(ctx(w), who(w)),
    ).rejects.toMatchObject({ reason: "entries" });
  });

  it("reads only objects under the person's own prefix", async () => {
    const w = await filesWorld();
    await stored(w, "saves", "s1", bytesOf(50));
    exec(w, `UPDATE files SET object_key = 'u/${SLUG}/ps_other/' || 'x'`);
    const entries = await cloudSyncStore.exportEntries!(ctx(w), who(w));
    await expect(
      new Response(zipStream(entries)).arrayBuffer(),
    ).rejects.toThrow();
  });
});
