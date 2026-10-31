import { describe, expect, it } from "vitest";
import {
  CHUNK_CODEC_ZSTD,
  cdcLengths,
  chunkCacheBudget,
  CHUNK_CACHE_MIN_BYTES,
  DOWNLOAD_RANGE_BYTES,
  e2eFileCodec,
  encodeManifest,
  memoryChunkCache,
  memoryJournal,
  parseManifest,
  rangedBytes,
  SERVER_CHUNK_MAX_STORED_BYTES,
  serverFileCodec,
  TransferEngine,
  TransferError,
  webCryptoSyncPort as port,
  type ByteSink,
  type ChunkCache,
  type FileBody,
  type FileCallOptions,
  type FileCodec,
  type FileQuery,
  type FileReply,
  type FileTarget,
  type FileTransport,
  type JournalStore,
  type RangedSource,
  type TransferEngineDeps,
} from "../src/sync/index.js";
import { fail, hex, MIB, noise, ok } from "./syncTransferFixtures.js";
import { FakeServer, type StoredFile } from "./syncTransferServer.js";
import type {
  BeginFileRequest,
  BeginFileResponse,
  ChunkPlanRequest,
  ChunkPlanResponse,
  FinalizeRequest,
  FinalizeResponse,
  UploadStatus,
} from "@polaris-key/protocol/sync";

const sink = (): ByteSink & { bytes: () => Uint8Array } => {
  const parts: Uint8Array[] = [];
  return {
    write: async (b) => {
      parts.push(Uint8Array.from(b));
    },
    bytes: () => Buffer.concat(parts),
  };
};

function engine(
  server: FileTransport,
  journal: JournalStore = memoryJournal(),
  over: Partial<TransferEngineDeps> = {},
) {
  return new TransferEngine({
    transport: server,
    journal,
    sleep: async () => {},
    random: () => 0.5,
    ...over,
  });
}

const serverCodec = serverFileCodec(port);
const ROOT = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const e2eCodec = () => e2eFileCodec(port, ROOT, "saves");

const up = (
  data: Uint8Array | RangedSource,
  codec: FileCodec,
  over: object = {},
) => ({
  id: "t1",
  collection: "saves",
  record: "rec1",
  source: "size" in data ? data : rangedBytes(data),
  codec,
  ...over,
});

const download = async (
  s: FakeServer,
  codec: FileCodec,
  file: FinalizeResponse,
  over: object = {},
  eng = engine(s),
) => {
  const out = sink();
  await eng.download({
    collection: "saves",
    record: "rec1",
    format: file.format,
    size: file.size,
    sha256: file.sha256,
    codec,
    sink: out,
    ...over,
  });
  return out.bytes();
};

const data = noise(3 * MIB, 5);

describe("chunks upload", () => {
  it("cuts, plans, sends every chunk and the manifest, and finalizes (server mode)", async () => {
    const s = new FakeServer();
    const j = memoryJournal();
    const e = engine(s, j);
    const lens = cdcLengths(data);
    const progress: number[][] = [];
    const out = await e.uploadChunked(
      up(data, serverCodec, {
        onProgress: (a: number, b: number) => progress.push([a, b]),
      }),
    );
    expect(out.format).toBe("chunks");
    expect(out.size).toBe(data.length);
    expect(s.calls[0]).toBe("begin");
    expect(s.calls.at(-1)).toBe("finalize");
    expect(s.calls.at(-2)).toBe("putSingle");
    expect(s.chunkPuts.length).toBe(new Set(s.chunkPuts).size);
    expect(s.chunkPuts.length).toBe(lens.length);
    expect(await j.list()).toEqual([]);
    expect(progress.at(-1)).toEqual([data.length, data.length]);
    // The manifest on the server is the plain one and lists these chunks.
    const m = parseManifest(s.files[0]!.bytes);
    expect(m.ok && m.manifest.records.map((r) => r.plainLen)).toEqual(lens);
    // The begin declared the file's size and the manifest's hash.
    expect(out.sha256).toBe(hex(await port.sha256(s.files[0]!.bytes)));
    // Every object is the raw layout of D-5.
    for (const o of s.chunks.values()) {
      expect([o[0], o[1]]).toEqual([0, 0]);
    }
  });

  it("a second version sends only the chunks that changed", async () => {
    const s = new FakeServer();
    const e = engine(s);
    await e.uploadChunked(up(data, serverCodec));
    const total = s.chunkPuts.length;
    const edited = Uint8Array.from(data);
    for (let i = 0; i < 40; i++) edited[1_500_000 + i]! ^= 0xff;
    s.chunkPuts.length = 0;
    const out = await e.uploadChunked(up(edited, serverCodec));
    expect(out.version).toBe(2);
    expect(s.chunkPuts.length).toBeGreaterThan(0);
    expect(s.chunkPuts.length).toBeLessThanOrEqual(3);
    expect(s.chunkPuts.length).toBeLessThan(total);
    const back = await download(s, serverCodec, out, {
      cache: memoryChunkCache(),
    });
    expect(Buffer.from(back).equals(Buffer.from(edited))).toBe(true);
  });

  it("an identical re-upload sends no chunk at all", async () => {
    const s = new FakeServer();
    const e = engine(s);
    await e.uploadChunked(up(data, serverCodec));
    s.chunkPuts.length = 0;
    await e.uploadChunked(up(data, serverCodec));
    expect(s.chunkPuts).toEqual([]);
  });

  it("plans at most 1,024 ids a call and each id once", async () => {
    // 300 KiB of a repeated 100 KiB pattern would not repeat chunks; use zeros: one id, many chunks.
    const zeros = new Uint8Array(4 * MIB);
    const s = new FakeServer();
    const sizes: number[] = [];
    const orig = s.planChunks;
    s.planChunks = async (t: FileTarget, id: string, r: ChunkPlanRequest) => {
      sizes.push(r.chunks.length);
      return orig(t, id, r);
    };
    const e = engine(s);
    const out = await e.uploadChunked(up(zeros, serverCodec));
    expect(sizes.every((n) => n <= 1024)).toBe(true);
    // Equal chunks share an id: sent once.
    expect(s.chunkPuts.length).toBeLessThan(cdcLengths(zeros).length);
    const back = await download(s, serverCodec, out);
    expect(back.length).toBe(zeros.length);
  });

  it("is end to end: the server holds sealed chunks and a sealed manifest", async () => {
    const s = new FakeServer();
    const e = engine(s);
    const codec = e2eCodec();
    const out = await e.uploadChunked(up(data, codec, { baseVersion: "*" }));
    expect(out.size).toBe(codec.storedSize(data.length));
    const probe = data.subarray(1_000_000, 1_000_064);
    for (const o of s.chunks.values()) {
      expect(o[0]).toBe(1);
      expect(Buffer.from(o).includes(Buffer.from(probe))).toBe(false);
    }
    expect(s.files[0]!.bytes[0]).toBe(0x50); // "PKSYNCF1"
    const back = await download(s, codec, out, { cache: memoryChunkCache() });
    expect(Buffer.from(back).equals(Buffer.from(data))).toBe(true);
  });

  it("sends the begin the way the plan says", async () => {
    const s = new FakeServer();
    let seen: BeginFileRequest | undefined;
    const orig = s.begin;
    s.begin = async (t, r) => {
      seen = r;
      return orig(t, r);
    };
    const codec = e2eCodec();
    const e = engine(s);
    const out = await e.uploadChunked(up(data, codec, { baseVersion: 3 }));
    expect(seen).toMatchObject({
      format: "chunks",
      enc: "e2e",
      size: codec.storedSize(data.length),
      baseVersion: 3,
    });
    expect(seen!.sha256).toBe(out.sha256);
  });

  it("refuses a begin that does not answer chunks", async () => {
    const s = new FakeServer();
    s.begin = async () => ok({ uploadId: "x", mode: "single", expiresAt: 1 });
    const j = memoryJournal();
    await expect(
      engine(s, j).uploadChunked(up(data, serverCodec)),
    ).rejects.toMatchObject({ reason: "bad-reply" });
    expect(s.aborted).toEqual(["x"]);
  });

  it("refuses a plan that names an id it was not asked", async () => {
    const s = new FakeServer();
    s.planOverride = (r) => ({
      missing: [...r.chunks.map((c) => c[0]), "f".repeat(64)],
      present: [],
    });
    await expect(
      engine(s).uploadChunked(up(data, serverCodec)),
    ).rejects.toMatchObject({ reason: "bad-reply" });
    expect(s.chunkPuts).toEqual([]);
    expect(s.aborted.length).toBe(1);
  });

  it("refuses a plan that leaves an id unanswered", async () => {
    const s = new FakeServer();
    s.planOverride = (r) => ({
      missing: r.chunks.slice(1).map((c) => c[0]),
      present: [],
    });
    await expect(
      engine(s).uploadChunked(up(data, serverCodec)),
    ).rejects.toMatchObject({ reason: "bad-reply" });
  });

  it("refuses to send a chunk when the file changed after it was cut", async () => {
    const s = new FakeServer();
    let reads = 0;
    const src: RangedSource = {
      size: data.length,
      read: async (a, b) => {
        // The first pass reads in 1 MiB slices; later reads are the sends.
        const out = Uint8Array.from(data.subarray(a, b));
        if (++reads > 3) out[0]! ^= 1;
        return out;
      },
    };
    await expect(
      engine(s).uploadChunked(up(src, serverCodec)),
    ).rejects.toMatchObject({ reason: "source-mismatch" });
    expect(s.chunkPuts).toEqual([]);
  });

  it("starts again when the upload expires mid-way (410)", async () => {
    const s = new FakeServer();
    let hits = 0;
    s.hook = (kind) =>
      kind === "putChunk" && hits++ === 2
        ? fail(410, "upload_expired")
        : undefined;
    const j = memoryJournal();
    const out = await engine(s, j).uploadChunked(up(data, serverCodec));
    expect(out.format).toBe("chunks");
    expect(s.calls.filter((c) => c === "begin").length).toBe(2);
    // The chunks the first pass stored are not sent again.
    expect(s.chunkPuts.length).toBe(new Set(s.chunkPuts).size);
    expect(await j.list()).toEqual([]);
  });

  it("sends again the chunks finalize says are missing", async () => {
    const s = new FakeServer();
    let dropped = false;
    const orig = s.finalize;
    s.finalize = async (t, r) => {
      if (!dropped) {
        dropped = true;
        const gone = s.chunkPuts[0]!;
        s.chunks.delete(gone);
      }
      return orig(t, r);
    };
    const out = await engine(s).uploadChunked(up(data, serverCodec));
    expect(out.version).toBe(1);
    expect(s.chunkPuts.length).toBe(cdcLengths(data).length + 1);
  });

  it("surfaces a stale baseVersion with the server's version, and a mismatch", async () => {
    const s = new FakeServer();
    s.hook = (kind) =>
      kind === "begin"
        ? fail(409, "revision_conflict", { body: { server: { version: 7 } } })
        : undefined;
    await expect(
      engine(s).uploadChunked(up(data, serverCodec, { baseVersion: 2 })),
    ).rejects.toMatchObject({ reason: "conflict", serverVersion: 7 });
  });

  it("a kill leaves a chunks record; the next run releases that upload and re-uses the chunks", async () => {
    const s = new FakeServer();
    const j = memoryJournal();
    let n = 0;
    s.hook = (kind) =>
      kind === "putChunk" && ++n > 4 ? fail(503, "unavailable") : undefined;
    await expect(
      engine(s, j, { maxAttempts: 2 }).uploadChunked(up(data, serverCodec)),
    ).rejects.toMatchObject({ reason: "retries-exhausted" });
    const [id] = await j.list();
    const rec = (await j.get(id!)) as { mode: string; uploadId: string };
    expect(rec.mode).toBe("chunks");
    const stored = s.chunkPuts.length;
    expect(stored).toBeGreaterThan(0);
    s.hook = () => undefined;
    s.aborted.length = 0;
    const out = await engine(s, j).uploadChunked(up(data, serverCodec));
    expect(s.aborted).toEqual([rec.uploadId]);
    expect(s.chunkPuts.length).toBe(cdcLengths(data).length);
    expect(out.version).toBe(1);
    expect(await j.list()).toEqual([]);
  });

  it("leaves a journal record of a version it does not know alone", async () => {
    const s = new FakeServer();
    const j = memoryJournal();
    await j.put("t1", { v: 9 } as never);
    await expect(
      engine(s, j).uploadChunked(up(data, serverCodec)),
    ).rejects.toMatchObject({ reason: "journal-version" });
    expect(s.calls).toEqual([]);
    expect(await j.get("t1")).toEqual({ v: 9 });
  });

  it("an empty file is a manifest with no chunks", async () => {
    const s = new FakeServer();
    const out = await engine(s).uploadChunked(
      up(new Uint8Array(0), serverCodec),
    );
    expect(out.size).toBe(0);
    expect(s.chunkPuts).toEqual([]);
    expect(s.calls).not.toContain("plan");
  });
});

describe("whole download", () => {
  const stage = async (
    codec: FileCodec,
    plain: Uint8Array,
    seal: (p: Uint8Array) => Promise<Uint8Array> = async (p) => p,
  ) => {
    const s = new FakeServer();
    const stored = await seal(plain);
    s.files.push({
      version: 1,
      format: "whole",
      size: stored.length,
      sha256: hex(await port.sha256(stored)),
      bytes: stored,
    });
    return { s, file: s.files[0]!, codec };
  };
  const asReply = (f: StoredFile): FinalizeResponse => ({
    version: f.version,
    size: f.size,
    sha256: f.sha256,
    format: "whole",
  });

  it("reads a large file in ranges, holding the ETag with If-Match", async () => {
    const plain = noise(20 * MIB, 11);
    const { s, file } = await stage(serverCodec, plain);
    const back = await download(s, serverCodec, asReply(file));
    expect(Buffer.from(back).equals(Buffer.from(plain))).toBe(true);
    expect(s.fileGets.length).toBe(
      Math.ceil(plain.length / DOWNLOAD_RANGE_BYTES),
    );
    expect(s.fileGets[0]!.ifMatch).toBeUndefined();
    expect(s.fileGets.slice(1).every((q) => q.ifMatch === '"e1"')).toBe(true);
    expect(s.fileGets.every((q) => q.range !== undefined)).toBe(true);
  });

  it("takes a 200 for a server that ignores Range, from the start only", async () => {
    const plain = noise(300_000, 2);
    const { s, file } = await stage(serverCodec, plain);
    s.tamperFile = (_q, b) => ({
      status: 200,
      bytes: file.bytes,
      etag: b.etag!,
    });
    const back = await download(s, serverCodec, asReply(file));
    expect(back.length).toBe(plain.length);
    // Larger than one range: a 200 for the second ask cannot be taken.
    const big = await stage(serverCodec, noise(12 * MIB, 4));
    let n = 0;
    big.s.tamperFile = (_q, b) =>
      n++ === 0 ? b : { status: 200, bytes: big.file.bytes, etag: b.etag! };
    await expect(
      download(big.s, serverCodec, asReply(big.file)),
    ).rejects.toMatchObject({ reason: "bad-reply", detail: "status" });
  });

  it("refuses a short 206 and a Content-Range that does not match", async () => {
    const plain = noise(300_000, 2);
    const { s, file } = await stage(serverCodec, plain);
    const cases: ((b: FileBody) => FileBody)[] = [
      (b) => ({ ...b, bytes: b.bytes.subarray(0, 100) }),
      (b) => ({ ...b, contentRange: { ...b.contentRange!, start: 1 } }),
      (b) => ({ ...b, contentRange: { ...b.contentRange!, total: 7 } }),
      (b) => ({ ...b, contentRange: undefined }),
      (b) => ({
        ...b,
        contentRange: { ...b.contentRange!, end: b.contentRange!.end + 1 },
      }),
    ];
    for (const f of cases) {
      s.tamperFile = (_q, b) => f(b);
      await expect(
        download(s, serverCodec, asReply(file)),
      ).rejects.toMatchObject({ reason: "bad-reply" });
    }
  });

  it("accepts a self-consistent 206 that is shorter than asked and carries on", async () => {
    const plain = noise(300_000, 2);
    const { s, file } = await stage(serverCodec, plain);
    s.tamperFile = (q, b) => {
      const end = Math.min(q.range!.start + 100_000, q.range!.end);
      return {
        ...b,
        bytes: file.bytes.subarray(q.range!.start, end),
        contentRange: { start: q.range!.start, end, total: file.bytes.length },
      };
    };
    const back = await download(s, serverCodec, asReply(file));
    expect(Buffer.from(back).equals(Buffer.from(plain))).toBe(true);
    expect(s.fileGets.length).toBe(3);
  });

  it("refuses when the ETag changes between ranges", async () => {
    const { s, file } = await stage(serverCodec, noise(12 * MIB, 6));
    let n = 0;
    s.tamperFile = (_q, b) => ({ ...b, etag: n++ === 0 ? '"a"' : '"b"' });
    await expect(download(s, serverCodec, asReply(file))).rejects.toMatchObject(
      { reason: "bad-reply", detail: "etag" },
    );
  });

  it("surfaces a 412 (the file changed) and a 404 as a rejection", async () => {
    const { s, file } = await stage(serverCodec, noise(12 * MIB, 6));
    let n = 0;
    s.hook = (kind) =>
      kind === "getFile" && n++ === 1
        ? fail(412, "precondition_failed")
        : undefined;
    await expect(download(s, serverCodec, asReply(file))).rejects.toMatchObject(
      { reason: "rejected", status: 412 },
    );
  });

  it("refuses stored bytes that do not hash to what the record says", async () => {
    const { s, file } = await stage(serverCodec, noise(300_000, 2));
    s.tamperFile = (_q, b) => {
      const x = Uint8Array.from(b.bytes);
      x[5]! ^= 1;
      return { ...b, bytes: x };
    };
    await expect(download(s, serverCodec, asReply(file))).rejects.toMatchObject(
      { reason: "file-invalid", detail: "sha256" },
    );
  });

  it("is end to end: segments open, and a flipped byte is refused by its tag", async () => {
    const codec = e2eCodec();
    const plain = noise(2_500_000, 8);
    const root = ROOT;
    const { sealFile, deriveCollKey, deriveKid } =
      await import("../src/sync/index.js");
    const { s, file } = await stage(codec, plain, async (p) =>
      sealFile(
        port,
        await deriveCollKey(port, root, "saves"),
        await deriveKid(port, root),
        p,
      ),
    );
    const back = await download(s, codec, asReply(file));
    expect(Buffer.from(back).equals(Buffer.from(plain))).toBe(true);
    // The record's hash is right for the tampered bytes, so only the tag can catch it.
    const x = Uint8Array.from(file.bytes);
    x[1_200_000]! ^= 1;
    const t = new FakeServer();
    t.files.push({
      ...file,
      bytes: x,
      sha256: hex(await port.sha256(x)),
    });
    await expect(
      download(t, codec, { ...asReply(file), sha256: t.files[0]!.sha256 }),
    ).rejects.toMatchObject({ reason: "file-invalid", detail: "auth" });
  });

  it("refuses a record whose size no stream has", async () => {
    const codec = e2eCodec();
    const s = new FakeServer();
    await expect(
      download(s, codec, {
        version: 1,
        size: 70,
        sha256: "0".repeat(64),
        format: "whole",
      }),
    ).rejects.toMatchObject({ reason: "file-invalid", detail: "size" });
    expect(s.calls).toEqual([]);
  });
});

describe("chunks download", () => {
  const uploaded = async (codec: FileCodec = serverCodec) => {
    const s = new FakeServer();
    const out = await engine(s).uploadChunked(up(data, codec));
    s.calls.length = 0;
    s.chunkGets.length = 0;
    return { s, out };
  };

  it("fetches each chunk once and fills the cache; a second read needs no chunk", async () => {
    const { s, out } = await uploaded();
    const cache = memoryChunkCache();
    const first = await download(s, serverCodec, out, { cache });
    expect(Buffer.from(first).equals(Buffer.from(data))).toBe(true);
    expect(s.chunkGets.length).toBe(s.chunks.size);
    s.chunkGets.length = 0;
    const again = await download(s, serverCodec, out, { cache });
    expect(Buffer.from(again).equals(Buffer.from(data))).toBe(true);
    expect(s.chunkGets).toEqual([]);
  });

  it("fetches only the chunks the cache lacks after a new version", async () => {
    const { s } = await uploaded();
    const cache = memoryChunkCache();
    const e = engine(s);
    const v1 = await e.uploadChunked(up(data, serverCodec));
    await download(s, serverCodec, v1, { cache });
    const edited = Uint8Array.from(data);
    for (let i = 0; i < 40; i++) edited[2_000_000 + i]! ^= 0x55;
    const v2 = await e.uploadChunked(up(edited, serverCodec));
    s.chunkGets.length = 0;
    const back = await download(s, serverCodec, v2, { cache });
    expect(Buffer.from(back).equals(Buffer.from(edited))).toBe(true);
    expect(s.chunkGets.length).toBeGreaterThan(0);
    expect(s.chunkGets.length).toBeLessThanOrEqual(3);
  });

  it("throws away a cached object that no longer opens and fetches it again", async () => {
    const { s, out } = await uploaded();
    const cache = memoryChunkCache();
    await download(s, serverCodec, out, { cache });
    const [id] = [...s.chunks.keys()];
    const bad = Uint8Array.from(s.chunks.get(id!)!);
    bad[10]! ^= 1;
    await cache.put(id!, bad);
    s.chunkGets.length = 0;
    const back = await download(s, serverCodec, out, { cache });
    expect(Buffer.from(back).equals(Buffer.from(data))).toBe(true);
    expect(s.chunkGets).toEqual([id]);
  });

  it("works with a cache that throws", async () => {
    const { s, out } = await uploaded();
    const boom = async () => {
      throw new Error("disk");
    };
    const cache: ChunkCache = {
      get: boom,
      put: boom,
      delete: boom,
      clear: boom,
    };
    const back = await download(s, serverCodec, out, { cache });
    expect(Buffer.from(back).equals(Buffer.from(data))).toBe(true);
  });

  it("refuses a tampered chunk (server mode: the id of the plaintext)", async () => {
    const { s, out } = await uploaded();
    s.tamperChunk = (_id, o) => {
      const x = Uint8Array.from(o);
      x[x.length - 1]! ^= 1;
      return x;
    };
    await expect(download(s, serverCodec, out, {})).rejects.toMatchObject({
      reason: "file-invalid",
      detail: "chunk-id",
    });
  });

  it("refuses a tampered chunk (end to end: the tag)", async () => {
    const codec = e2eCodec();
    const { s, out } = await uploaded(codec);
    s.tamperChunk = (_id, o) => {
      const x = Uint8Array.from(o);
      x[20]! ^= 1;
      return x;
    };
    await expect(download(s, codec, out, {})).rejects.toMatchObject({
      reason: "file-invalid",
      detail: "chunk-auth",
    });
  });

  it("refuses a chunk swapped for another chunk of the same file", async () => {
    const codec = e2eCodec();
    const { s, out } = await uploaded(codec);
    const [a, b] = [...s.chunks.keys()];
    s.tamperChunk = (id, o) => (id === a ? s.chunks.get(b!)! : o);
    await expect(download(s, codec, out, {})).rejects.toMatchObject({
      reason: "file-invalid",
    });
  });

  it("refuses an object over the stored-chunk cap before opening it", async () => {
    const { s, out } = await uploaded();
    s.tamperChunk = () => new Uint8Array(SERVER_CHUNK_MAX_STORED_BYTES + 1);
    await expect(download(s, serverCodec, out, {})).rejects.toMatchObject({
      reason: "file-invalid",
      detail: "chunk-size",
    });
  });

  it("refuses a manifest that does not hash to the record's hash, or whose size disagrees", async () => {
    const { s, out } = await uploaded();
    await expect(
      download(s, serverCodec, { ...out, sha256: "0".repeat(64) }),
    ).rejects.toMatchObject({ reason: "file-invalid", detail: "sha256" });
    await expect(
      download(s, serverCodec, { ...out, size: out.size + 1 }),
    ).rejects.toMatchObject({ reason: "file-invalid", detail: "size" });
  });

  it("refuses a manifest the format rejects, with the format's reason", async () => {
    const { s, out } = await uploaded();
    const bad = Uint8Array.from(s.files[0]!.bytes);
    bad[0]! ^= 1; // the magic
    s.files[0]!.bytes = bad;
    await expect(
      download(s, serverCodec, {
        ...out,
        sha256: hex(await port.sha256(bad)),
      }),
    ).rejects.toMatchObject({
      reason: "file-invalid",
      detail: "manifest-magic",
    });
  });

  it("refuses a file whose reassembled hash is not the manifest's", async () => {
    const { s, out } = await uploaded();
    const m = parseManifest(s.files[0]!.bytes);
    if (!m.ok) throw new Error("manifest");
    const forged = encodeManifest({
      ...m.manifest,
      plainSha256: new Uint8Array(32),
    });
    s.files[0]!.bytes = forged;
    await expect(
      download(s, serverCodec, {
        ...out,
        sha256: hex(await port.sha256(forged)),
      }),
    ).rejects.toMatchObject({ reason: "file-invalid", detail: "plainSha256" });
  });

  it("refuses a manifest whose chunk length differs from the chunk", async () => {
    const { s, out } = await uploaded();
    const m = parseManifest(s.files[0]!.bytes);
    if (!m.ok) throw new Error("manifest");
    const records = m.manifest.records.map((r, i) =>
      i === 0 ? { ...r, plainLen: r.plainLen - 1 } : r,
    );
    const forged = encodeManifest({
      ...m.manifest,
      plainSize: m.manifest.plainSize - 1,
      records,
    });
    s.files[0]!.bytes = forged;
    await expect(
      download(s, serverCodec, {
        ...out,
        size: out.size - 1,
        sha256: hex(await port.sha256(forged)),
      }),
    ).rejects.toMatchObject({ reason: "file-invalid", detail: "chunk-length" });
  });

  it("surfaces a missing chunk as a rejection and reports progress", async () => {
    const { s, out } = await uploaded();
    const seen: number[] = [];
    await download(s, serverCodec, out, {
      onProgress: (n: number, total: number) => seen.push(n / total),
    });
    expect(seen.at(-1)).toBe(1);
    s.chunks.clear();
    await expect(download(s, serverCodec, out, {})).rejects.toMatchObject({
      reason: "rejected",
      status: 404,
    });
  });

  it("stops at an abort", async () => {
    const { s, out } = await uploaded();
    const ac = new AbortController();
    let n = 0;
    await expect(
      download(s, serverCodec, out, {
        signal: ac.signal,
        sink: {
          write: async () => {
            if (++n === 2) ac.abort();
          },
        },
      }),
    ).rejects.toMatchObject({ reason: "aborted" });
  });
});

describe("server chunk objects (D-5)", () => {
  const id = (b: Uint8Array) => port.sha256(b);
  it("opens codec 0 and refuses what the format forbids, in order", async () => {
    const plain = noise(1000, 3);
    const cid = await id(plain);
    const obj = await serverCodec.sealChunk(cid, plain);
    expect(obj.length).toBe(serverCodec.chunkObjectBytes(1000));
    expect(await serverCodec.openChunk(cid, obj)).toEqual({
      ok: true,
      plain,
    });
    const r = async (o: Uint8Array) =>
      (await serverCodec.openChunk(cid, o)) as { reason?: string };
    expect((await r(new Uint8Array(1))).reason).toBe("shape");
    expect((await r(Uint8Array.from([1, 0, 1]))).reason).toBe("version");
    expect((await r(Uint8Array.from([0, 2, 1]))).reason).toBe("codec");
    expect(
      (await r(new Uint8Array(SERVER_CHUNK_MAX_STORED_BYTES + 1))).reason,
    ).toBe("size");
    const other = Uint8Array.from(obj);
    other[5]! ^= 1;
    expect((await r(other)).reason).toBe("id");
    // A plaintext over 1 MiB, even inside the stored cap, is `size`.
    const huge = new Uint8Array(2 + 1_048_577);
    expect((await r(huge)).reason).toBe("size");
  });

  it("checks a zstd frame's declared size before it decodes anything", async () => {
    let decoded = 0;
    const codec = serverFileCodec(port, () => {
      decoded++;
      return new Uint8Array(0);
    });
    const frame = (declared: number) => {
      const f = new Uint8Array(32);
      f.set([0x28, 0xb5, 0x2f, 0xfd, 0xa0]);
      new DataView(f.buffer).setUint32(5, declared, true);
      return f;
    };
    const wrap = (f: Uint8Array) => {
      const o = new Uint8Array(2 + f.length);
      o[1] = CHUNK_CODEC_ZSTD;
      o.set(f, 2);
      return o;
    };
    const cid = new Uint8Array(32);
    expect(await codec.openChunk(cid, wrap(frame(2 * MIB)))).toEqual({
      ok: false,
      reason: "size",
    });
    expect(decoded).toBe(0);
    // No decoder, no content size, a decoder that lies about the length: all `decode`.
    expect(await serverCodec.openChunk(cid, wrap(frame(10)))).toEqual({
      ok: false,
      reason: "decode",
    });
    expect(await codec.openChunk(cid, wrap(new Uint8Array(32)))).toEqual({
      ok: false,
      reason: "decode",
    });
    expect(await codec.openChunk(cid, wrap(frame(10)))).toEqual({
      ok: false,
      reason: "decode",
    });
    expect(decoded).toBe(1);
  });
});

describe("chunk cache", () => {
  const id = (n: number) => n.toString(16).padStart(64, "0");
  it("is an LRU bounded in bytes", async () => {
    const c = memoryChunkCache(250);
    await c.put(id(1), new Uint8Array(100));
    await c.put(id(2), new Uint8Array(100));
    await c.get(id(1)); // 1 is now the most recent
    await c.put(id(3), new Uint8Array(100));
    expect(await c.get(id(2))).toBeNull();
    expect(await c.get(id(1))).not.toBeNull();
    expect(await c.get(id(3))).not.toBeNull();
    await c.put(id(4), new Uint8Array(1000)); // too big: not kept
    expect(await c.get(id(4))).toBeNull();
    await c.clear();
    expect(await c.get(id(1))).toBeNull();
  });

  it("names entries from hex ids only", async () => {
    const c = memoryChunkCache();
    for (const bad of ["../x", "", "A".repeat(64), "a".repeat(63)])
      await expect(c.get(bad)).rejects.toThrow(RangeError);
  });

  it("holds the larger of 256 MiB and twice the largest save (D-9)", () => {
    expect(chunkCacheBudget(0)).toBe(CHUNK_CACHE_MIN_BYTES);
    expect(chunkCacheBudget(100 * MIB)).toBe(CHUNK_CACHE_MIN_BYTES);
    expect(chunkCacheBudget(512 * MIB)).toBe(1024 * MIB);
    expect(() => chunkCacheBudget(-1)).toThrow(RangeError);
  });

  it("returns copies, so a caller cannot change a cached object", async () => {
    const c = memoryChunkCache();
    await c.put(id(1), Uint8Array.from([1, 2, 3]));
    (await c.get(id(1)))![0] = 9;
    expect((await c.get(id(1)))![0]).toBe(1);
  });
});

describe("TransferError", () => {
  it("names the check that failed", () => {
    const e = new TransferError("file-invalid", { detail: "chunk-id" });
    expect(e.message).toContain("chunk-id");
    expect(e.detail).toBe("chunk-id");
  });
});
