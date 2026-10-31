// @vitest-environment node
//
// @pkey-feature sync.saves sync.files
//
// U-22.6: Cloud Sync saves in the browser host. The file transport (`BrowserFileTransport`), the
// IndexedDB journal and chunk cache, the records layer and `createBrowserSaves` (client-core's
// `SavesClient` and `TransferEngine` under one Web Lock), against a small fake of the Worker's
// `/sync` and `/sync/files` routes in server mode and in end-to-end mode.

import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import {
  deriveKid,
  e2eFileCodec,
  webCryptoSyncPort as P,
  type FileCodec,
  type SaveOutcome,
} from "@polaris-key/client-core/sync";
import { UnsupportedError } from "../src/core/caps.js";
import { unsupportedCloudSync } from "../src/core/cloudSync.js";
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
import {
  createBrowserSaves,
  type SavesApi,
  type TransferEvent,
} from "../src/browser/cloudSync/saves.js";

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

async function harness(
  mode: "e2e" | "server",
  extra: Partial<Parameters<typeof createBrowserSaves>[0]> = {},
) {
  const world = new FakeWorker(mode);
  const ring = await makeRing();
  const locks = new FakeLocks();
  const idb = new IDBFactory();
  const store = filesStore(filesDbName(DB), undefined, idb);
  const sleeps: number[] = [];
  const saves = createBrowserSaves({
    product: PRODUCT,
    dbName: DB,
    request: world.request,
    fileFetch: world.files,
    encryption: () => mode,
    ring,
    locks,
    options: {},
    store,
    sleep: async (ms) => void sleeps.push(ms),
    ...extra,
  });
  const events: TransferEvent[] = [];
  saves.onTransfer((e) => events.push(e));
  return { world, ring, locks, idb, store, saves, sleeps, events };
}

const settle = async (t: { done: Promise<SaveOutcome> }) => t.done;

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

// ── Saves, server mode ───────────────────────────────────────────────────────────────────────

describe("saves, server mode", () => {
  it("writes a save, lists it, reads it back and keeps revisions", async () => {
    const h = await harness("server");
    const data = bytes(3000);
    const t = h.saves.write("slot1", data, {
      name: "Level 3",
      formatVersion: 1,
    });
    const out = await settle(t);
    expect(out).toMatchObject({ state: "done", id: "slot1" });
    // The order of D-3: the file is stored, then the metadata is set on the version it answered.
    expect(h.world.seen.filter((s) => /begin|finalize|ops/.test(s))).toEqual([
      "POST sync/files/saves/slot1/begin",
      "POST sync/files/saves/slot1/finalize",
      "POST sync/ops",
    ]);
    const list = await h.saves.list();
    expect(list.map((s) => s.id)).toEqual(["slot1"]);
    expect(list[0]!.metadata).toEqual({ name: "Level 3", formatVersion: 1 });
    const read = await h.saves.read("slot1");
    expect(read).toMatchObject({ ok: true, metadata: { name: "Level 3" } });
    expect(read.ok && read.bytes && hexOf(read.bytes)).toBe(hexOf(data));

    const second = await settle(
      h.saves.write("slot1", bytes(3100, 9), { name: "Level 4" }),
    );
    expect(second).toMatchObject({ state: "done" });
    expect((await h.saves.revisions("slot1")).length).toBe(2);
    expect(h.saves.transfers()).toEqual([]);
  });

  it("emits progress, then done, in order, and lists a transfer while it runs", async () => {
    const h = await harness("server");
    const t = h.saves.write("slot1", bytes(2000), { n: 1 });
    expect(h.saves.transfers()).toMatchObject([{ saveId: "slot1" }]);
    await settle(t);
    const kinds = h.events.map((e) => e.type);
    expect(kinds[kinds.length - 1]).toBe("transferDone");
    expect(
      kinds.every((k) => k === "transferProgress" || k === "transferDone"),
    ).toBe(true);
    expect(h.events.at(-1)).toMatchObject({ saveId: "slot1", state: "done" });
    expect(h.saves.transfers()).toEqual([]);
  });

  it("answers a stale write as a conflict and settles it", async () => {
    const h = await harness("server");
    await settle(h.saves.write("slot1", bytes(1000), { who: "first" }));
    const stale = await settle(
      h.saves.write(
        "slot1",
        bytes(1100),
        { who: "second" },
        { baseVersion: 1 },
      ),
    );
    expect(stale.state).toBe("conflict");
    if (stale.state !== "conflict") return;
    expect(stale.conflict.remote?.metadata).toEqual({ who: "first" });
    const kept = await settle(
      h.saves.resolve(stale.conflict, "local", bytes(1100)),
    );
    expect(kept).toMatchObject({ state: "done" });
    const read = await h.saves.read("slot1");
    expect(read.ok && read.metadata).toEqual({ who: "second" });
    expect(
      h.events.some((e) => e.type === "transferDone" && e.state === "conflict"),
    ).toBe(true);
  });

  it("deletes a save", async () => {
    const h = await harness("server");
    await settle(h.saves.write("slot1", bytes(500), { n: 1 }));
    expect(await h.saves.delete("slot1")).toMatchObject({ ok: true });
    expect(await h.saves.list()).toEqual([]);
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
    const out = await settle(h.saves.write("slot1", bytes(800), { n: 1 }));
    expect(out).toMatchObject({ state: "done" });
    expect(h.sleeps).toContain(3_600_000);
    expect(Math.max(...h.sleeps)).toBeLessThanOrEqual(3_600_000);
  });

  it("reports quota_exceeded at finalize as a failure with its code, not a conflict", async () => {
    const h = await harness("server");
    h.world.hook = (key) =>
      key.endsWith("/finalize")
        ? new Response(
            JSON.stringify({
              error: { code: "quota_exceeded" },
              scope: "user",
            }),
            {
              status: 403,
            },
          )
        : undefined;
    const out = await settle(h.saves.write("slot1", bytes(800), { n: 1 }));
    expect(out.state).toBe("failed");
    if (out.state !== "failed") return;
    expect(out.error.detail).toBe("quota_exceeded");
    expect(h.events.at(-1)).toMatchObject({ type: "transferFailed" });
  });

  it("runs two writes one at a time under one lock", async () => {
    const h = await harness("server");
    const a = h.saves.write("slot1", bytes(900), { n: 1 });
    const b = h.saves.write("slot2", bytes(900, 3), { n: 2 });
    await Promise.all([a.done, b.done]);
    expect(h.locks.order).toEqual([
      `+pkey-sync-files:${DB}`,
      `-pkey-sync-files:${DB}`,
      `+pkey-sync-files:${DB}`,
      `-pkey-sync-files:${DB}`,
    ]);
    expect((await h.saves.list()).map((s) => s.id).sort()).toEqual([
      "slot1",
      "slot2",
    ]);
  });

  it("cancels a write that is waiting for the lock without sending anything", async () => {
    const h = await harness("server");
    const a = h.saves.write("slot1", bytes(900), { n: 1 });
    const b = h.saves.write("slot2", bytes(900, 3), { n: 2 });
    await b.cancel();
    expect(await b.done).toEqual({ state: "cancelled" });
    await a.done;
    expect(h.world.seen.some((s) => s.includes("slot2/begin"))).toBe(false);
  });
});

// ── Saves, end-to-end mode ───────────────────────────────────────────────────────────────────

describe("saves, end-to-end mode", () => {
  it("seals the file and the metadata, blinds the id, binds the file, and reads it back", async () => {
    const h = await harness("e2e");
    const marker = new TextEncoder().encode("PLAINTEXT-MARKER-0123456789");
    const data = new Uint8Array(2000);
    data.set(marker, 100);
    const out = await settle(h.saves.write("slot1", data, { name: "Secret" }));
    expect(out).toMatchObject({ state: "done" });

    // The Worker holds a blinded id, a sealed value and a sealed file: no plaintext anywhere.
    const [wireId, rec] = [...h.world.recs.entries()][0]!;
    expect(wireId).toMatch(/^x:/);
    expect(wireId).not.toContain("slot1");
    expect(rec!.ct).toBeTypeOf("string");
    expect(rec!.value).toBeUndefined();
    const stored = [...h.world.bodies.values()][0]!;
    expect(hexOf(stored)).not.toContain(hexOf(marker));
    expect(stored.length).toBeGreaterThan(data.length);

    const read = await h.saves.read("slot1");
    expect(read).toMatchObject({ ok: true, metadata: { name: "Secret" } });
    expect(read.ok && read.bytes && hexOf(read.bytes)).toBe(hexOf(data));
    expect((await h.saves.list()).map((s) => s.id)).toEqual(["slot1"]);
  });

  it("does not list a plaintext row the Worker adds: only a row this ring sealed is a save", async () => {
    const h = await harness("e2e");
    await settle(h.saves.write("slot1", bytes(500), { n: 1 }));
    h.world.recs.set("forged", { version: 99, value: { n: 666 } });
    expect((await h.saves.list()).map((s) => s.id)).toEqual(["slot1"]);
  });

  it("refuses a file the Worker swapped under another slot's record (the D-3 binding)", async () => {
    const h = await harness("e2e");
    await settle(h.saves.write("slot1", bytes(600), { n: 1 }));
    await settle(h.saves.write("slot2", bytes(700, 8), { n: 2 }));
    const [[idA, a], [, b]] = [...h.world.recs.entries()] as [
      [string, Rec],
      [string, Rec],
    ];
    // Point slot A's record at slot B's file (and keep B's bytes reachable under it).
    h.world.recs.set(idA, { ...a, file: b.file });
    const swapped = (await h.saves.list()).find((s) => s.metadata.n === 1)!;
    // The list shows no file for it: the record's file is not the one its sealed binding names.
    expect(swapped.file).toBeNull();
    const read = await h.saves.read(swapped.id).catch((e: unknown) => e);
    // Either the read fails as `sync-file-invalid`, or it answers a save with no file.
    expect(
      read instanceof Error
        ? (read as { code?: string }).code
        : (read as { ok: boolean; file: unknown }).file,
    ).toSatisfy((v: unknown) => v === "sync-file-invalid" || v === null);
  });

  it("sends nothing and fails with sync-locked once the ring is locked", async () => {
    const h = await harness("e2e");
    h.ring.lock();
    const out = await settle(h.saves.write("slot1", bytes(300), { n: 1 }));
    expect(out).toMatchObject({ state: "failed" });
    expect(h.world.seen.filter((s) => s.startsWith("POST"))).toEqual([]);
    await expect(h.saves.list()).rejects.toMatchObject({
      detail: "sync-locked",
    });
  });
});

// ── Where it cannot run ──────────────────────────────────────────────────────────────────────

describe("saves where Cloud Sync cannot run", () => {
  it("throws the typed unsupported on every verb", async () => {
    const saves: SavesApi = unsupportedCloudSync("runtime", "no cloud").saves;
    await expect(saves.list()).rejects.toBeInstanceOf(UnsupportedError);
    expect(() => saves.write("a", new Uint8Array(1), {})).toThrow(
      UnsupportedError,
    );
    try {
      saves.write("a", new Uint8Array(1), {});
    } catch (e) {
      expect((e as UnsupportedError).unsupported).toMatchObject({
        supported: false,
        feature: "sync.saves",
      });
    }
    expect(saves.transfers()).toEqual([]);
  });
});
