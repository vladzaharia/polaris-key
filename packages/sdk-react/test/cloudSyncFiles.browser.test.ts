// @vitest-environment node
//
// @pkey-feature sync.files sync.files.delta
//
// U-22.6: Cloud Sync files in the browser host. The file transport (`BrowserFileTransport`), the
// IndexedDB journal and chunk cache, and `createBrowserFiles` (client-core's `TransferEngine` under
// one Web Lock), against a small fake of the Worker's `/sync/files` routes in server mode and in
// end-to-end mode. The saves records binding is not here: it waits on the machine change of U-22.5.

import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import {
  deriveKid,
  e2eFileCodec,
  rangedBytes,
  serverFileCodec,
  webCryptoSyncPort as P,
  type FileCodec,
} from "@polaris-key/client-core/sync";
import { ringCodec } from "../src/browser/ring/codec.js";
import {
  importRootHandle,
  memoryRootVault,
  ringKeysOf,
} from "../src/browser/ring/rootVault.js";
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

const PRODUCT = "djdl";
const DB = "pkey-sync-test";
const RAW = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const hexOf = (b: Uint8Array) =>
  [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha = async (b: Uint8Array) => hexOf(await P.sha256(b));
type Body = Record<string, unknown>;

const bytes = (n: number, seed = 5): Uint8Array<ArrayBuffer> =>
  Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 255);

// ── A fake of the Worker's /sync and /sync/files routes ──────────────────────────────────────

interface Rec {
  version: number;
  value?: unknown;
  ct?: string;
  file?: { version: number; size: number; sha256: string; format: "whole" };
}

class FakeWorker {
  seq = 0;
  encryption: "e2e" | "server";
  recs = new Map<string, Rec>();
  bodies = new Map<string, Uint8Array>(); // by file version
  uploads = new Map<
    string,
    {
      id: string;
      size: number;
      base: number | "*" | undefined;
      sha256: string;
      body?: Uint8Array;
    }
  >();
  tombstones: string[] = [];
  seen: string[] = [];
  /** Answers a route instead of the truth: `[method path-suffix]` to a response. */
  hook: (key: string) => Response | undefined = () => undefined;
  rawFileBodies: Uint8Array[] = [];

  constructor(encryption: "e2e" | "server") {
    this.encryption = encryption;
  }

  private j = (
    b: unknown,
    status = 200,
    headers: Record<string, string> = {},
  ) =>
    new Response(JSON.stringify(b), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });

  private err = (status: number, code: string, extra: Body = {}, h = {}) =>
    this.j({ error: { code }, ...extra }, status, h);

  /** `ProductRequest`: the sync routes, JSON in and out. */
  request = async (
    path: string,
    init: { method: string; body?: string },
  ): Promise<Response> => {
    const url = new URL(`https://k.test/${PRODUCT}/${path}`);
    const body = init.body ? (JSON.parse(init.body) as Body) : undefined;
    return this.route(init.method, url, body, undefined);
  };

  /** `FileFetch`: the file routes, bytes in and out. */
  files: FileFetch = async (path, init) => {
    const url = new URL(`https://k.test/${PRODUCT}/${path}`);
    const raw =
      init.body instanceof Uint8Array
        ? init.body
        : init.body === undefined
          ? undefined
          : new TextEncoder().encode(init.body);
    const json =
      init.headers["content-type"] === "application/json" && raw
        ? (JSON.parse(new TextDecoder().decode(raw)) as Body)
        : undefined;
    if (raw && !json) this.rawFileBodies.push(raw);
    return this.route(init.method, url, json, raw, init.headers);
  };

  private async route(
    method: string,
    url: URL,
    body: Body | undefined,
    raw: Uint8Array | undefined,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const rel = url.pathname.slice(`/${PRODUCT}/`.length);
    this.seen.push(`${method} ${rel}`);
    const hooked = this.hook(`${method} ${rel}`);
    if (hooked) return hooked;
    if (rel === "sync" && method === "GET") return this.pull();
    if (rel === "sync/ops") return this.push(body!);
    const m = /^sync\/files\/saves\/([^/]+)(?:\/(.*))?$/.exec(rel);
    if (!m) return this.err(404, "not_found");
    const [, id, rest = ""] = m as unknown as [string, string, string?];
    if (rest === "begin") return this.begin(id, body!);
    if (rest === "finalize") return this.finalize(id, body!);
    if (rest === "revisions") return this.revisions(id);
    const up = /^upload\/([^/]+)$/.exec(rest);
    if (up && method === "PUT") return this.put(up[1]!, raw!, headers);
    if (up && method === "DELETE") {
      this.uploads.delete(up[1]!);
      return new Response(null, { status: 204 });
    }
    if (rest === "" && method === "GET")
      return this.download(id, url.searchParams.get("version"), headers.range);
    return this.err(404, "not_found");
  }

  private begin(id: string, b: Body): Response {
    const cur = this.recs.get(id);
    const base = b.baseVersion as number | "*" | undefined;
    if (
      (base === "*" && cur) ||
      (typeof base === "number" && cur?.version !== base)
    )
      return this.err(409, "revision_conflict", {
        server: { version: cur?.version ?? 0 },
      });
    const uploadId = `up_${this.uploads.size + 1}`;
    this.uploads.set(uploadId, {
      id,
      size: b.size as number,
      base,
      sha256: b.sha256 as string,
    });
    return this.j({
      uploadId,
      mode: "single",
      expiresAt: Date.now() + 86_400_000,
    });
  }

  private async put(
    uploadId: string,
    raw: Uint8Array,
    headers: Record<string, string>,
  ): Promise<Response> {
    const u = this.uploads.get(uploadId);
    if (!u) return this.err(404, "not_found");
    const digest = digestHeader(await sha(raw));
    if (headers["content-digest"] !== digest)
      return this.err(400, "upload_mismatch");
    u.body = raw;
    return new Response(null, { status: 204 });
  }

  private async finalize(id: string, b: Body): Promise<Response> {
    const u = this.uploads.get(b.uploadId as string);
    if (!u?.body) return this.err(409, "upload_incomplete", { missing: [1] });
    const cur = this.recs.get(id);
    if (
      (u.base === "*" && cur) ||
      (typeof u.base === "number" && cur?.version !== u.base)
    )
      return this.err(409, "revision_conflict", {
        server: { version: cur?.version ?? 0 },
      });
    const version = ++this.seq;
    const file = {
      version,
      size: u.body.length,
      sha256: await sha(u.body),
      format: "whole" as const,
    };
    this.bodies.set(String(version), u.body);
    this.recs.set(id, { ...(cur ?? {}), version, file });
    this.uploads.delete(b.uploadId as string);
    return this.j(file);
  }

  private download(
    id: string,
    version: string | null,
    range?: string,
  ): Response {
    const rec = this.recs.get(id);
    const v = version ?? String(rec?.file?.version);
    const data = this.bodies.get(v);
    if (!rec || !data) return this.err(404, "not_found");
    const etag = `"${[...this.bodies.keys()].indexOf(v)}"`;
    const rg = range ? /^bytes=(\d+)-(\d+)$/.exec(range) : null;
    if (rg) {
      const a = Number(rg[1]);
      const z = Math.min(Number(rg[2]) + 1, data.length);
      return new Response(data.slice(a, z), {
        status: 206,
        headers: {
          etag,
          "content-range": `bytes ${a}-${z - 1}/${data.length}`,
        },
      });
    }
    return new Response(data.slice(), { status: 200, headers: { etag } });
  }

  private revisions(id: string): Response {
    const rec = this.recs.get(id);
    return this.j({
      revisions: [...this.bodies.entries()]
        .reverse()
        .filter(([v]) => rec?.file && Number(v) <= rec.file.version)
        .map(([v, data]) => ({
          version: Number(v),
          size: data.length,
          sha256: "",
          format: "whole",
          createdAt: 0,
        })),
    });
  }

  private pull(): Response {
    return this.j(
      this.envelope({
        changes: [...this.recs.entries()].map(([id, r]) => ({
          record: ["saves", id],
          version: r.version,
          ...(r.ct !== undefined ? { ct: r.ct } : {}),
          ...(r.value !== undefined ? { value: r.value } : {}),
          ...(r.file ? { file: r.file } : {}),
        })),
        tombstones: this.tombstones.map((id) => ({
          record: ["saves", id],
          editedHlc: "x",
        })),
      }),
    );
  }

  private envelope(over: Body): Body {
    return {
      subject: "ps_x",
      serverNow: 1,
      cursor: this.seq,
      more: false,
      lastMutationId: 0,
      catalogVersion: 1,
      aliases: {},
      usage: { files: 0, records: 0, settings: 0, bytes: 0 },
      quota: { files: true, bytes: 2 ** 28 },
      encryption: this.encryption,
      encryptionSince: 1,
      changes: [],
      tombstones: [],
      ...over,
    };
  }

  private push(b: Body): Response {
    const results = (b.mutations as Array<Body>).map((m) => {
      const [, id] = (m.target as { record: [string, string] }).record;
      const cur = this.recs.get(id);
      const base = m.baseVersion as number | "*" | undefined;
      if (
        (base === "*" && cur) ||
        (typeof base === "number" && cur?.version !== base)
      )
        return {
          mutationId: m.mutationId,
          status: "conflict",
          server: cur
            ? {
                version: cur.version,
                ...(cur.ct !== undefined ? { ct: cur.ct } : {}),
                ...(cur.value !== undefined ? { value: cur.value } : {}),
                ...(cur.file ? { file: cur.file } : {}),
              }
            : { version: 0 },
        };
      if (m.op === "delete") {
        this.recs.delete(id);
        this.tombstones.push(id);
        return { mutationId: m.mutationId, status: "ok", version: ++this.seq };
      }
      const version = ++this.seq;
      this.recs.set(id, {
        ...(cur ?? {}),
        version,
        ...(m.ct !== undefined ? { ct: m.ct as string } : { value: m.value }),
      });
      return { mutationId: m.mutationId, status: "ok", version };
    });
    return this.j(this.envelope({ results }));
  }
}

// ── The key ring and the locks ───────────────────────────────────────────────────────────────

async function makeRing(root: Uint8Array = RAW) {
  const vault = memoryRootVault();
  await vault.put({
    v: 1 as const,
    ringId: "rg_AAAAAAAAAAAAAAAAAAAAAA",
    epoch: 1,
    kid: hexOf(await deriveKid(P, root)),
    key: await importRootHandle(root),
  });
  let held = true;
  const keys = async () => {
    const rec = await vault.get();
    return rec ? ringKeysOf(rec, P) : null;
  };
  const codec = ringCodec({ hasRoot: () => held, ringKeys: keys });
  return {
    codec: () => (held ? codec : null),
    fileCodec: async (c: string): Promise<FileCodec | null> => {
      const k = held ? await keys() : null;
      return k ? k.withRoot(async (p, r) => e2eFileCodec(p, r, c)) : null;
    },
    lock: () => void (held = false),
  };
}

class FakeLocks {
  order: string[] = [];
  private tails = new Map<string, Promise<unknown>>();
  request(name: string, a: unknown, b?: unknown): Promise<unknown> {
    const fn = (typeof a === "function" ? a : b) as (l: unknown) => unknown;
    const prev = this.tails.get(name) ?? Promise.resolve();
    const run = prev.then(async () => {
      this.order.push(`+${name}`);
      try {
        return await fn({ name });
      } finally {
        this.order.push(`-${name}`);
      }
    });
    this.tails.set(
      name,
      run.catch(() => undefined),
    );
    return run;
  }
}

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
    await h.files.engine.upload({
      id: "t1",
      ...target,
      source: rangedBytes(b),
      size: b.length,
      sha256: await sha(b),
      enc: "none",
      baseVersion: "*",
    });
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
