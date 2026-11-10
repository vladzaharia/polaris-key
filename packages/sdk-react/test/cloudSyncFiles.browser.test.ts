// @vitest-environment node
//
// @pkey-feature sync.files sync.files.delta
//
// U-22.6: Cloud Sync files in the browser host. The file transport (`BrowserFileTransport`), the
// IndexedDB journal and chunk cache, and `createBrowserFiles` (client-core's `TransferEngine` under
// one Web Lock), against a small fake of the Worker's `/sync/files` routes in server mode and in
// end-to-end mode. The saves API on top of it is test/cloudSyncSaves.test.ts.

import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import {
  SAVES_FILE_INVALID,
  encodeManifest,
  rangedBytes,
  sealChunk,
  serverFileCodec,
  webCryptoSyncPort as P,
} from "@polaris-key/client-core/sync";
import {
  BrowserFileTransport,
  digestHeader,
  isFilesPath,
  type FileFetch,
} from "../src/browser/cloudSync/files.js";
import {
  filesDbName,
  purgeFilesStore,
} from "../src/browser/cloudSync/filesPurge.js";
import { filesStore } from "../src/browser/cloudSync/idbJournal.js";
import { createBrowserFiles } from "../src/browser/cloudSync/fileTransfers.js";
import {
  FakeLocks,
  FakeWorker,
  PRODUCT,
  RAW,
  hexOf,
  makeRing,
  sha,
} from "./savesFixtures.js";

const DB = "pkey-sync-test";

const bytes = (n: number, seed = 5): Uint8Array<ArrayBuffer> =>
  Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 255);

async function harness(mode: "e2e" | "server") {
  const world = new FakeWorker(mode);
  const ring = await makeRing();
  const locks = new FakeLocks();
  const idb = new IDBFactory();
  const store = filesStore(filesDbName(DB), undefined, idb);
  const sleeps: number[] = [];
  const files = createBrowserFiles({
    product: PRODUCT,
    dbName: DB,
    fileFetch: world.files,
    locks,
    store,
    sleep: async (ms) => void sleeps.push(ms),
  });
  return { world, ring, locks, idb, store, files, sleeps };
}

// ── The file transport ───────────────────────────────────────────────────────────────────────

describe("the browser file transport", () => {
  it("accepts only the file routes of the product", () => {
    const ok = (p: string) => isFilesPath(PRODUCT, p);
    expect(ok(`/${PRODUCT}/sync/files/saves/slot1/begin`)).toBe(true);
    expect(ok(`/${PRODUCT}/sync/files/saves/slot1?version=3`)).toBe(true);
    expect(ok(`/${PRODUCT}/sync/files/saves/slot1/upload/up_1/parts/2`)).toBe(
      true,
    );
    expect(ok(`/${PRODUCT}/sync/files/saves/chunks/${"a".repeat(64)}`)).toBe(
      true,
    );
    expect(ok(`/${PRODUCT}/sync/files/saves/../x/begin`)).toBe(false);
    expect(ok(`/${PRODUCT}/sync/files/saves/slot1?version=x`)).toBe(false);
    expect(ok(`/${PRODUCT}/sync/ops`)).toBe(false);
    expect(ok(`/other/sync/files/saves/slot1/begin`)).toBe(false);
    expect(ok(`/${PRODUCT}/sync/files/saves/slot1/upload/up_1/chunks/zz`)).toBe(
      false,
    );
  });

  const transport = (
    res: () => Response,
    seen: Array<{ path: string; init: Parameters<FileFetch>[1] }> = [],
  ) =>
    new BrowserFileTransport({
      product: PRODUCT,
      request: async (path, init) => {
        seen.push({ path, init });
        return res();
      },
    });

  it("sends the digest of a body, a range and If-Match, and no cookie-bearing option", async () => {
    const seen: Array<{ path: string; init: Parameters<FileFetch>[1] }> = [];
    const body = bytes(100);
    const t = transport(() => new Response(null, { status: 204 }), seen);
    const r = await t.putSingle(
      { collection: "saves", record: "slot1" },
      "up_1",
      body,
      await sha(body),
      {},
    );
    expect(r.ok).toBe(true);
    expect(seen[0]!.path).toBe("sync/files/saves/slot1/upload/up_1");
    expect(seen[0]!.init.headers["content-digest"]).toBe(
      digestHeader(await sha(body)),
    );
    expect(seen[0]!.init.headers["content-type"]).toBe(
      "application/octet-stream",
    );

    seen.length = 0;
    const g = transport(
      () =>
        new Response(bytes(10), {
          status: 206,
          headers: { "content-range": "bytes 5-14/100", etag: '"a"' },
        }),
      seen,
    );
    const got = await g.getFile(
      { collection: "saves", record: "slot1" },
      { range: { start: 5, end: 15 }, ifMatch: '"a"', version: 2 },
      {},
    );
    expect(seen[0]!.path).toBe("sync/files/saves/slot1?version=2");
    expect(seen[0]!.init.headers.range).toBe("bytes=5-14");
    expect(seen[0]!.init.headers["if-match"]).toBe('"a"');
    expect(got).toMatchObject({
      ok: true,
      value: { status: 206, contentRange: { start: 5, end: 15, total: 100 } },
    });
  });

  it("refuses a bad id before any request and a redirect after one", async () => {
    const seen: unknown[] = [];
    const t = transport(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.test/" },
        }),
      seen as never,
    );
    await expect(
      t.begin(
        { collection: "saves", record: "../x" },
        { size: 1, sha256: "0".repeat(64), format: "whole", enc: "none" },
        {},
      ),
    ).rejects.toMatchObject({ reason: "rejected" });
    expect(seen).toHaveLength(0);
    const r = await t.status(
      { collection: "saves", record: "slot1" },
      "up_1",
      {},
    );
    expect(r).toMatchObject({
      ok: false,
      status: 302,
      code: "redirect_refused",
    });
  });

  it("reads Retry-After and the extra members of a refusal, and bounds a long body", async () => {
    const t = transport(
      () =>
        new Response(
          JSON.stringify({ error: { code: "unavailable" }, missing: [1] }),
          {
            status: 503,
            headers: { "retry-after": "120" },
          },
        ),
    );
    expect(
      await t.status({ collection: "saves", record: "s" }, "up_1", {}),
    ).toMatchObject({
      ok: false,
      status: 503,
      code: "unavailable",
      retryAfterSeconds: 120,
      body: { missing: [1] },
    });
    const big = transport(() => new Response(bytes(40), { status: 200 }));
    expect(
      await big.getFile(
        { collection: "saves", record: "s" },
        { range: { start: 0, end: 10 } },
        {},
      ),
    ).toMatchObject({ ok: false, code: "bad_response" });
  });
});

// ── The journal and the chunk cache ──────────────────────────────────────────────────────────

describe("the IndexedDB journal and chunk cache", () => {
  const record = (id: string) => ({
    v: 1 as const,
    id,
    kind: "upload" as const,
    collection: "saves",
    record: "slot1",
    uploadId: "up_1",
    mode: "single" as const,
    partBytes: null,
    done: [],
    sha256: "a".repeat(64),
    size: 10,
    expiresAt: 1,
    state: "uploading" as const,
  });

  it("keeps an upload's record across a reopen", async () => {
    const idb = new IDBFactory();
    const a = filesStore("db1", undefined, idb);
    await a.journal.put("t1", record("t1"));
    a.close();
    const b = filesStore("db1", undefined, idb);
    expect(await b.journal.list()).toEqual(["t1"]);
    expect(await b.journal.get("t1")).toMatchObject({ uploadId: "up_1" });
    await b.journal.delete("t1");
    expect(await b.journal.get("t1")).toBeNull();
  });

  it("evicts the least recently used chunk over its budget, and refuses a name that is not a chunk id", async () => {
    const idb = new IDBFactory();
    const s = filesStore("db2", 250, idb);
    const id = (n: number) => String(n).repeat(64).slice(0, 64);
    await s.cache.put(id(1), bytes(100));
    await new Promise((r) => setTimeout(r, 5));
    await s.cache.put(id(2), bytes(100));
    await new Promise((r) => setTimeout(r, 5));
    await s.cache.get(id(1)); // touches 1
    await new Promise((r) => setTimeout(r, 5));
    await s.cache.put(id(3), bytes(100));
    expect(await s.cache.get(id(2))).toBeNull();
    expect(await s.cache.get(id(1))).not.toBeNull();
    expect(await s.cache.get(id(3))).not.toBeNull();
    await expect(s.cache.get("../etc")).rejects.toThrow(RangeError);
    await s.cache.put(id(4), bytes(300)); // over the whole budget: not kept
    expect(await s.cache.get(id(4))).toBeNull();
  });

  it("is deleted whole by a purge, loaded or not", async () => {
    const idb = new IDBFactory();
    const s = filesStore("db3", undefined, idb);
    await s.journal.put("t1", record("t1"));
    await s.meta.put("k", 1);
    await s.purge();
    expect((await idb.databases()).some((d) => d.name === "db3")).toBe(false);
    const again = filesStore("db3", undefined, idb);
    expect(await again.journal.list()).toEqual([]);
    again.close();
    await purgeFilesStore("db3", idb);
    expect((await idb.databases()).some((d) => d.name === "db3")).toBe(false);
  });

  it("a scoped purge removes the leaving person's chunks and leaves another's", async () => {
    const idb = new IDBFactory();
    const s = filesStore("db4", undefined, idb);
    const id = (n: number) => String(n).repeat(64).slice(0, 64);
    await s.scoped("alice").put(id(1), new Uint8Array([1]));
    await s.scoped("bob").put(id(1), new Uint8Array([2]));
    await s.journal.put("t1", record("t1"));
    await s.purge("alice");
    expect((await idb.databases()).some((d) => d.name === "db4")).toBe(true);
    const again = filesStore("db4", undefined, idb);
    expect(await again.scoped("alice").get(id(1))).toBeNull();
    expect(await again.scoped("bob").get(id(1))).toEqual(new Uint8Array([2]));
    expect(await again.journal.list()).toEqual([]);
    // The last person's purge takes the database with it.
    await again.purge("bob");
    expect((await idb.databases()).some((d) => d.name === "db4")).toBe(false);
  });

  it("falls back to memory where the page has no IndexedDB", async () => {
    const prev = (globalThis as { indexedDB?: unknown }).indexedDB;
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
    try {
      const s = filesStore("db4");
      expect(s.persistence).toBe("memory");
      await s.journal.put("t1", record("t1"));
      expect(await s.journal.list()).toEqual(["t1"]);
    } finally {
      if (prev !== undefined)
        (globalThis as { indexedDB?: unknown }).indexedDB = prev;
    }
  });
});

// ── The engine over the transport, the journal and the lock ──────────────────────────────────

describe("the file layer: engine, journal, cache and one writer", () => {
  const target = { collection: "saves", record: "slot1" };

  it("uploads and downloads a file in server mode through the transport", async () => {
    const h = await harness("server");
    const data = bytes(3000);
    const codec = serverFileCodec(P);
    const sealed = await collect(codec.sealStream(streamOf(data)));
    const finalized = await h.files.engine.upload({
      id: "t1",
      collection: target.collection,
      record: target.record,
      source: rangedBytes(sealed),
      size: sealed.length,
      sha256: await sha(sealed),
      enc: "none",
      baseVersion: "*",
    });
    expect(finalized).toMatchObject({
      version: 1,
      size: 3000,
      format: "whole",
    });
    expect(h.world.seen).toEqual([
      "POST sync/files/saves/slot1/begin",
      "PUT sync/files/saves/slot1/upload/up_1",
      "POST sync/files/saves/slot1/finalize",
    ]);
    expect(await h.files.journal.list()).toEqual([]);
    const parts: Uint8Array[] = [];
    await h.files.engine.download({
      ...target,
      format: "whole",
      size: finalized.size,
      sha256: finalized.sha256,
      codec,
      cache: h.files.cache,
      sink: { write: async (b) => void parts.push(Uint8Array.from(b)) },
    });
    expect(hexOf(Buffer.concat(parts))).toBe(hexOf(data));
  });

  it("seals the file under the ring's keys and the Worker holds no plaintext", async () => {
    const h = await harness("e2e");
    const marker = new TextEncoder().encode("PLAINTEXT-MARKER-0123456789");
    const data = new Uint8Array(2000);
    data.set(marker, 100);
    const codec = (await h.ring.fileCodec("saves"))!;
    const sealed = await collect(codec.sealStream(streamOf(data)));
    const out = await h.files.engine.upload({
      id: "t1",
      ...target,
      source: rangedBytes(sealed),
      size: sealed.length,
      sha256: await sha(sealed),
      enc: "e2e",
      baseVersion: "*",
    });
    const stored = [...h.world.bodies.values()][0]!;
    expect(hexOf(stored)).not.toContain(hexOf(marker));
    const parts: Uint8Array[] = [];
    await h.files.engine.download({
      ...target,
      format: "whole",
      size: out.size,
      sha256: out.sha256,
      codec,
      sink: { write: async (b) => void parts.push(Uint8Array.from(b)) },
    });
    expect(hexOf(Buffer.concat(parts))).toBe(hexOf(data));
  });

  it("refuses a chunk the Worker stored with zstd (codec 1) as sync-file-invalid: the browser carries no decoder", async () => {
    const h = await harness("e2e");
    const codec = (await h.ring.fileCodec("saves"))!;
    // One zstd frame of a raw block with a 1-byte content size: 'A'.
    const frame = Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd, 0x20, 1, 9, 0, 0, 0x41);
    const plain = Uint8Array.of(0x41);
    const id = await codec.chunkId(plain);
    const object = await sealChunk(P, RAW, "saves", id, 1, frame);
    const manifest = await codec.sealManifest(
      encodeManifest({
        plainSize: 1,
        plainSha256: await P.sha256(plain),
        records: [{ id, plainLen: 1 }],
      }),
    );
    h.world.bodies.set("1", manifest);
    h.world.recs.set("m1", {
      version: 1,
      file: {
        version: 1,
        size: manifest.length,
        sha256: await sha(manifest),
        format: "whole",
      },
    });
    h.world.hook = (key) =>
      key === `GET sync/files/saves/chunks/${hexOf(id)}`
        ? new Response(object.slice(), { status: 200 })
        : undefined;
    const sink: Uint8Array[] = [];
    await expect(
      h.files.engine.download({
        collection: "saves",
        record: "m1",
        format: "chunks",
        size: manifest.length,
        sha256: await sha(manifest),
        codec,
        cache: h.files.cache,
        sink: { write: async (b) => void sink.push(Uint8Array.from(b)) },
      }),
    ).rejects.toMatchObject({ reason: "file-invalid" });
    // The same failure through the saves client's mapping is the registered code.
    expect(SAVES_FILE_INVALID).toBe("sync-file-invalid");
    expect(await h.files.cache.get(hexOf(id))).toBeNull();
  });

  it("has no file codec once the ring is locked", async () => {
    const h = await harness("e2e");
    h.ring.lock();
    expect(await h.ring.fileCodec("saves")).toBeNull();
  });

  it("surfaces a stale baseVersion as a conflict with the server's version", async () => {
    const h = await harness("server");
    const up = async (id: string, base: number | "*", seed: number) => {
      const b = bytes(900, seed);
      return h.files.engine.upload({
        id,
        ...target,
        source: rangedBytes(b),
        size: b.length,
        sha256: await sha(b),
        enc: "none",
        baseVersion: base,
      });
    };
    await up("t1", "*", 1);
    await expect(up("t2", 7, 2)).rejects.toMatchObject({
      reason: "conflict",
      serverVersion: 1,
    });
  });

  it("backs off a 503 with Retry-After, capped at 3600 seconds, and goes on", async () => {
    const h = await harness("server");
    let n = 0;
    h.world.hook = (key) =>
      key.endsWith("/begin") && n++ === 0
        ? new Response(JSON.stringify({ error: { code: "unavailable" } }), {
            status: 503,
            headers: { "retry-after": "99999" },
          })
        : undefined;
    const b = bytes(800);
    // The engine waits `hold.until - Date.now()`: a frozen clock makes the capped wait exact
    // instead of 3_600_000 minus however many milliseconds the upload took.
    const frozen = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    try {
      await h.files.engine.upload({
        id: "t1",
        ...target,
        source: rangedBytes(b),
        size: b.length,
        sha256: await sha(b),
        enc: "none",
        baseVersion: "*",
      });
    } finally {
      frozen.mockRestore();
    }
    expect(h.sleeps).toContain(3_600_000);
    expect(Math.max(...h.sleeps)).toBeLessThanOrEqual(3_600_000);
  });

  it("reports quota_exceeded at finalize as a rejection with its code", async () => {
    const h = await harness("server");
    h.world.hook = (key) =>
      key.endsWith("/finalize")
        ? new Response(
            JSON.stringify({
              error: { code: "quota_exceeded" },
              scope: "user",
            }),
            { status: 403 },
          )
        : undefined;
    const b = bytes(800);
    await expect(
      h.files.engine.upload({
        id: "t1",
        ...target,
        source: rangedBytes(b),
        size: b.length,
        sha256: await sha(b),
        enc: "none",
        baseVersion: "*",
      }),
    ).rejects.toMatchObject({
      reason: "rejected",
      code: "quota_exceeded",
      status: 403,
    });
  });

  it("resumes an upload from the journal after the page is gone", async () => {
    const h = await harness("server");
    const b = bytes(1200);
    const req = async () => ({
      id: "t1",
      ...target,
      source: rangedBytes(b),
      size: b.length,
      sha256: await sha(b),
      enc: "none" as const,
      baseVersion: "*" as const,
    });
    // The first run stores the part, then the finalize never answers (the tab is killed).
    h.world.hook = (key) =>
      key.endsWith("/finalize") ? new Response("", { status: 599 }) : undefined;
    const first = h.files.engine.upload({ ...(await req()) });
    await first.catch(() => undefined);
    // A new page: the same database, a new engine.
    h.files.store.close();
    h.world.hook = () => undefined;
    const again = createBrowserFiles({
      product: PRODUCT,
      dbName: DB,
      fileFetch: h.world.files,
      locks: h.locks,
      store: filesStore(filesDbName(DB), undefined, h.idb),
      sleep: async () => undefined,
    });
    const out = await again.engine.upload({ ...(await req()) });
    expect(out).toMatchObject({ version: 1 });
    // One begin only: the second run found the upload in the journal and finalized it.
    expect(h.world.seen.filter((s) => s.endsWith("/begin"))).toHaveLength(1);
  });

  it("runs two writers one at a time under one lock, and a purge deletes the state", async () => {
    const h = await harness("server");
    const order: string[] = [];
    const a = h.files.exclusive(async () => {
      order.push("a+");
      await new Promise((r) => setTimeout(r, 5));
      order.push("a-");
    });
    const b = h.files.exclusive(async () => {
      order.push("b+");
      order.push("b-");
    });
    await Promise.all([a, b]);
    expect(order).toEqual(["a+", "a-", "b+", "b-"]);
    expect(
      h.locks.order.every((x) => x.endsWith(`pkey-sync-files:${DB}`)),
    ).toBe(true);
    await h.files.journal.put("x", {
      v: 1,
      id: "x",
      kind: "upload",
      collection: "saves",
      record: "r",
      uploadId: "up_9",
      mode: "single",
      partBytes: null,
      done: [],
      sha256: "a".repeat(64),
      size: 1,
      expiresAt: 1,
      state: "uploading",
    });
    await h.files.purge();
    expect(
      (await h.idb.databases()).some((d) => d.name === filesDbName(DB)),
    ).toBe(false);
  });
});

async function collect(it: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const p of it) parts.push(Uint8Array.from(p));
  return Uint8Array.from(Buffer.concat(parts));
}

async function* streamOf(data: Uint8Array): AsyncGenerator<Uint8Array> {
  yield data;
}
