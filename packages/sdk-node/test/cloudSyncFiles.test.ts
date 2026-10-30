// @pkey-feature sync.files
// The Node file transport, journal and chunk cache (U-22.4) under client-core's transfer engine,
// against a small fake of the Worker's file routes. It pins the security points of
// plans/U-22-U-23-U-37-U-41-slices.md section 4 that this layer owns: the path allow-list (a save
// id may hold dots), no redirects, `Content-Digest`, body bounds equal to what was asked, journal
// and cache files named only from hashes and hex ids and kept at 0600, nothing but ids and counts
// in the journal, and the bearer token never in an error.

import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  memoryChunkCache,
  rangedBytes,
  serverFileCodec,
  TransferEngine,
  TransferError,
  webCryptoSyncPort,
  type ByteSink,
  type TransferJournalRecord,
} from "@polaris-key/client-core/sync";
import type { FinalizeResponse } from "@polaris-key/protocol/sync";
import { FileChunkCache, chunkCacheDir } from "../src/cloudSync/chunkCache.js";
import {
  FILES_MANIFEST_MAX_BYTES,
  NodeFileTransport,
  isFilesPath,
} from "../src/cloudSync/files.js";
import { FileJournal, journalFileName } from "../src/cloudSync/journal.js";

const PRODUCT = "djdl";
const TOKEN = `pkeyt_${"T".repeat(43)}`;
const BASE = "https://key.test";
const sha = (b: Uint8Array): string =>
  createHash("sha256").update(b).digest("hex");
const tmp = (): string => mkdtempSync(join(tmpdir(), "pkey-files-"));

type Handler = (
  url: URL,
  init: RequestInit,
  seen: Seen,
) => Response | Promise<Response>;
interface Seen {
  method: string;
  path: string;
  headers: Headers;
  body: Uint8Array | undefined;
  redirect: RequestInit["redirect"];
}

function rig(handler: Handler, token: string | null = TOKEN) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const s: Seen = {
      method: init.method ?? "GET",
      path: url.pathname + url.search,
      headers: new Headers(init.headers),
      body:
        init.body === undefined
          ? undefined
          : typeof init.body === "string"
            ? new TextEncoder().encode(init.body)
            : (init.body as Uint8Array),
      redirect: init.redirect,
    };
    seen.push(s);
    return handler(url, init, s);
  }) as typeof fetch;
  const transport = new NodeFileTransport({
    ctx: {
      product: PRODUCT,
      baseUrl: BASE,
      requestTimeoutMs: 15_000,
      headers: (extra = {}) => ({ "x-pkey-device": "DEVICE", ...extra }),
      plainFetcher: () => fetchImpl,
    },
    token: () => token,
  });
  return { transport, seen };
}

const T = { collection: "saves", record: "slot-1" };
const json = (
  b: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response => new Response(JSON.stringify(b), { status, headers });

describe("the path allow-list", () => {
  const ok = [
    "/djdl/sync/files/saves/slot-1/begin",
    "/djdl/sync/files/saves/slot-1/finalize",
    "/djdl/sync/files/saves/slot-1/revisions",
    "/djdl/sync/files/saves/slot-1",
    "/djdl/sync/files/saves/slot-1?version=3",
    "/djdl/sync/files/saves/x:abc_DEF-123/upload/up.1",
    "/djdl/sync/files/saves/slot-1/upload/up1/parts/9999",
    "/djdl/sync/files/saves/slot-1/upload/up1/chunks",
    `/djdl/sync/files/saves/slot-1/upload/up1/chunks/${"a".repeat(64)}`,
    `/djdl/sync/files/saves/chunks/${"0".repeat(64)}`,
    // Dots inside a segment are fine; only a whole `.` or `..` is a traversal.
    "/djdl/sync/files/saves/a..b/begin",
  ];
  const refused = [
    "/djdl/sync/files/saves/../begin",
    "/djdl/sync/files/saves/./begin",
    "/djdl/sync/files/saves/slot-1/upload/../parts/1",
    "/djdl/sync/files/saves/%2e%2e/begin",
    "/djdl/sync/files/saves/slot 1/begin",
    "/djdl/sync/files/saves/slot-1/upload/up1/parts/0x1",
    "/djdl/sync/files/saves/slot-1/upload/up1/parts/12345",
    `/djdl/sync/files/saves/slot-1/upload/up1/chunks/${"A".repeat(64)}`,
    `/djdl/sync/files/saves/chunks/${"a".repeat(63)}`,
    "/djdl/sync/files/saves/slot-1/begin/extra",
    "/djdl/sync/files/saves/slot-1/begin?x=1",
    "/djdl/sync/files/saves/slot-1/upload/up1?version=1",
    "/djdl/sync/files/saves/slot-1?version=1&x=2",
    "/djdl/sync/files/saves/slot-1?version=-1",
    "/other/sync/files/saves/slot-1/begin",
    "/djdl/sync/ops",
    "/djdl/sync/files/saves",
    "//evil.test/djdl/sync/files/saves/slot-1/begin",
  ];
  it.each(ok)("allows %s", (p) => expect(isFilesPath(PRODUCT, p)).toBe(true));
  it.each(refused)("refuses %s", (p) =>
    expect(isFilesPath(PRODUCT, p)).toBe(false),
  );

  it("sends no request for a record or upload id that climbs out", async () => {
    const { transport, seen } = rig(() => json({}));
    for (const record of ["..", ".", "a/b", "a b", "a?b", "", "x".repeat(129)])
      await expect(
        transport.begin(
          { collection: "saves", record },
          { size: 1, sha256: "0".repeat(64), format: "whole", enc: "none" },
          {},
        ),
      ).rejects.toBeInstanceOf(TransferError);
    await expect(transport.status(T, "../x", {})).rejects.toBeInstanceOf(
      TransferError,
    );
    await expect(
      transport.putPart(T, "up1", 0, new Uint8Array(1), "0".repeat(64), {}),
    ).rejects.toBeInstanceOf(TransferError);
    await expect(
      transport.putChunk(
        T,
        "up1",
        "../..",
        new Uint8Array(1),
        "0".repeat(64),
        {},
      ),
    ).rejects.toBeInstanceOf(TransferError);
    await expect(
      transport.getChunk("saves", "A".repeat(64), {}),
    ).rejects.toBeInstanceOf(TransferError);
    await expect(
      transport.getFile(T, { range: { start: 5, end: 5 } }, {}),
    ).rejects.toBeInstanceOf(TransferError);
    expect(seen).toEqual([]);
  });
});

describe("the transport", () => {
  it("sends the bearer, the SDK headers and a Content-Digest of the body", async () => {
    const { transport, seen } = rig(() => new Response(null, { status: 204 }));
    const body = new Uint8Array([1, 2, 3, 4]);
    const r = await transport.putPart(T, "up1", 2, body, sha(body), {});
    expect(r).toEqual({ ok: true, value: null });
    expect(seen).toHaveLength(1);
    const s = seen[0]!;
    expect(s.method).toBe("PUT");
    expect(s.path).toBe("/djdl/sync/files/saves/slot-1/upload/up1/parts/2");
    expect(s.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(s.headers.get("x-pkey-device")).toBe("DEVICE");
    expect(s.headers.get("content-type")).toBe("application/octet-stream");
    expect(s.headers.get("content-digest")).toBe(
      `sha-256=:${Buffer.from(sha(body), "hex").toString("base64")}:`,
    );
    expect(s.redirect).toBe("manual");
  });

  it("refuses a digest that is not a SHA-256 hex, and sends nothing", async () => {
    const { transport, seen } = rig(() => new Response(null, { status: 204 }));
    await expect(
      transport.putSingle(T, "up1", new Uint8Array(1), "zz", {}),
    ).rejects.toBeInstanceOf(TransferError);
    expect(seen).toEqual([]);
  });

  it("follows no redirect: a 3xx is a refusal and the second URL is never asked", async () => {
    const { transport, seen } = rig(
      () =>
        new Response(null, {
          status: 307,
          headers: { location: "https://evil.test/steal" },
        }),
    );
    const r = await transport.putSingle(
      T,
      "up1",
      new Uint8Array([1]),
      sha(new Uint8Array([1])),
      {},
    );
    expect(r).toMatchObject({
      ok: false,
      status: 307,
      code: "redirect_refused",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.redirect).toBe("manual");
  });

  it("answers 401 and sends nothing without a bearer", async () => {
    const { transport, seen } = rig(() => json({}), null);
    const r = await transport.finalize(T, { uploadId: "up1" }, {});
    expect(r).toMatchObject({ ok: false, status: 401, code: "unauthorized" });
    expect(seen).toEqual([]);
  });

  it("reads an error: the server's code, Retry-After and the extra members", async () => {
    const { transport } = rig((url) =>
      url.pathname.endsWith("/finalize")
        ? json(
            {
              error: { code: "upload_incomplete", message: "no" },
              missing: [2, 3],
            },
            409,
          )
        : json({ error: "rate_limited" }, 429, { "retry-after": "7" }),
    );
    expect(await transport.finalize(T, { uploadId: "up1" }, {})).toEqual({
      ok: false,
      status: 409,
      code: "upload_incomplete",
      body: { missing: [2, 3] },
    });
    const limited = await transport.begin(
      T,
      { size: 1, sha256: "0".repeat(64), format: "whole", enc: "none" },
      {},
    );
    expect(limited).toMatchObject({
      ok: false,
      status: 429,
      code: "rate_limited",
      retryAfterSeconds: 7,
    });
    // A revision conflict's `server.version` survives, nested or flat.
    const { transport: t2 } = rig(() =>
      json(
        { error: { code: "revision_conflict", server: { version: 9 } } },
        409,
      ),
    );
    const c = await t2.finalize(T, { uploadId: "up1" }, {});
    expect(c).toMatchObject({
      ok: false,
      body: { server: { version: 9 } },
    });
  });

  it("answers a 2xx it cannot use as bad_response, not as an answer", async () => {
    const cases: Array<[string, Response]> = [
      ["not json", new Response("<html>", { status: 200 })],
      ["a list", json([1])],
      ["no uploadId", json({ mode: "single", expiresAt: 1 })],
      [
        "a dot uploadId",
        json({ uploadId: "..", mode: "single", expiresAt: 1 }),
      ],
      ["a bad mode", json({ uploadId: "u", mode: "other", expiresAt: 1 })],
    ];
    for (const [, res] of cases) {
      const { transport } = rig(() => res.clone());
      const r = await transport.begin(
        T,
        { size: 1, sha256: "0".repeat(64), format: "whole", enc: "none" },
        {},
      );
      expect(r).toMatchObject({ ok: false, code: "bad_response" });
    }
  });

  it("bounds a ranged GET to the range asked, even when the server sends more", async () => {
    const big = new Uint8Array(2000).fill(7);
    const { transport } = rig((_u, _i, s) => {
      const asked = /bytes=(\d+)-(\d+)/.exec(s.headers.get("range")!)!;
      const start = Number(asked[1]);
      return new Response(big.subarray(start, start + 1500), {
        status: 206,
        headers: {
          "content-range": `bytes ${start}-${start + 1499}/2000`,
          etag: '"abc"',
        },
      });
    });
    const over = await transport.getFile(
      T,
      { range: { start: 0, end: 1000 } },
      {},
    );
    expect(over).toMatchObject({ ok: false, code: "bad_response" });
    const { transport: t2 } = rig((_u, _i, s) => {
      const asked = /bytes=(\d+)-(\d+)/.exec(s.headers.get("range")!)!;
      expect(s.headers.get("if-match")).toBe('"abc"');
      const [a, b] = [Number(asked[1]), Number(asked[2])];
      return new Response(big.subarray(a, b + 1), {
        status: 206,
        headers: {
          "content-range": `bytes ${a}-${b}/2000`,
          etag: '"abc"',
        },
      });
    });
    const ok = await t2.getFile(
      T,
      { range: { start: 1000, end: 2000 }, ifMatch: '"abc"' },
      {},
    );
    expect(ok).toMatchObject({
      ok: true,
      value: {
        status: 206,
        etag: '"abc"',
        contentRange: { start: 1000, end: 2000, total: 2000 },
      },
    });
    if (ok.ok) expect(ok.value.bytes).toHaveLength(1000);
  });

  it("bounds a chunk GET and an unranged GET, and reads a short Content-Length", async () => {
    const { transport } = rig(
      () => new Response(new Uint8Array(1_048_607), { status: 200 }),
    );
    expect(await transport.getChunk("saves", "a".repeat(64), {})).toMatchObject(
      {
        ok: false,
        code: "bad_response",
      },
    );
    const { transport: t2 } = rig(
      () => new Response(new Uint8Array(1_048_606), { status: 200 }),
    );
    const edge = await t2.getChunk("saves", "a".repeat(64), {});
    expect(edge.ok && edge.value.length).toBe(1_048_606);
    // The declared length alone refuses it, before any body is read.
    const { transport: t3 } = rig(
      () =>
        new Response(new Uint8Array(10), {
          headers: { "content-length": String(FILES_MANIFEST_MAX_BYTES + 1) },
        }),
    );
    expect(await t3.getFile(T, {}, {})).toMatchObject({
      ok: false,
      code: "bad_response",
    });
  });

  it("an answer that is not 200 or 206 to a file GET is not an answer", async () => {
    const { transport } = rig(() => new Response(null, { status: 204 }));
    expect(await transport.getFile(T, {}, {})).toMatchObject({
      ok: false,
      code: "bad_response",
    });
  });

  it("a network failure throws and carries no token", async () => {
    const { transport } = rig(() => {
      throw new Error("ECONNRESET");
    });
    const err = await transport
      .finalize(T, { uploadId: "up1" }, {})
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).not.toContain(TOKEN);
  });
});

describe("the journal", () => {
  const record = (id: string, over: Partial<TransferJournalRecord> = {}) =>
    ({
      v: 1,
      id,
      kind: "upload",
      collection: "saves",
      record: "slot-1",
      uploadId: "up1",
      mode: "single",
      partBytes: null,
      done: [],
      sha256: "a".repeat(64),
      size: 10,
      expiresAt: 2_000_000_000,
      state: "uploading",
      ...over,
    }) as TransferJournalRecord;

  it("keeps a record in a file named by the hash of its id, at 0600", async () => {
    const dir = tmp();
    const j = new FileJournal(dir);
    const id = "../../escape";
    await j.put(id, record(id));
    const names = readdirSync(j.dir);
    expect(names).toEqual([journalFileName(id)]);
    expect(names[0]).toMatch(/^[0-9a-f]{64}\.json$/);
    expect(statSync(join(j.dir, names[0]!)).mode & 0o777).toBe(0o600);
    expect(statSync(j.dir).mode & 0o777).toBe(0o700);
    expect(existsSync(join(dir, "escape"))).toBe(false);
    expect(await j.get(id)).toEqual(record(id));
    expect(await j.list()).toEqual([id]);
    await j.delete(id);
    expect(await j.get(id)).toBeNull();
    expect(await j.list()).toEqual([]);
  });

  it("holds ids, counts and hashes only", async () => {
    const dir = tmp();
    const j = new FileJournal(dir);
    await j.put("t1", record("t1"));
    const text = readFileSync(join(j.dir, journalFileName("t1")), "utf8");
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(
      [
        "collection",
        "done",
        "expiresAt",
        "id",
        "kind",
        "mode",
        "partBytes",
        "record",
        "sha256",
        "size",
        "state",
        "uploadId",
        "v",
      ].sort(),
    );
    expect(text).not.toContain("pkeyt_");
  });

  it("reads a missing or garbled file as no record, and returns a foreign version as found", async () => {
    const dir = tmp();
    const j = new FileJournal(dir);
    expect(await j.get("none")).toBeNull();
    await j.put("t1", record("t1"));
    writeFileSync(join(j.dir, journalFileName("t1")), "{not json");
    expect(await j.get("t1")).toBeNull();
    const future = { ...record("t2"), v: 2 };
    writeFileSync(join(j.dir, journalFileName("t2")), JSON.stringify(future));
    expect(await j.get("t2")).toEqual(future);
  });

  it("lists only records that sit in the file their own id names; clear removes all", async () => {
    const dir = tmp();
    const j = new FileJournal(dir);
    await j.put("t1", record("t1"));
    // A copy under another name is not t2's record.
    writeFileSync(
      join(j.dir, journalFileName("t2")),
      JSON.stringify(record("t1")),
    );
    writeFileSync(join(j.dir, "notes.txt"), "x");
    expect(await j.list()).toEqual(["t1"]);
    await j.clear();
    expect(existsSync(j.dir)).toBe(false);
    expect(await j.list()).toEqual([]);
  });

  it("serialises writes: a delete after a put leaves nothing", async () => {
    const dir = tmp();
    const j = new FileJournal(dir);
    const first = j.put("t1", record("t1"));
    const second = j.delete("t1");
    await Promise.all([first, second]);
    expect(await j.get("t1")).toBeNull();
  });
});

describe("the chunk cache", () => {
  const id = (n: number) => n.toString(16).padStart(64, "0");

  it("names entries by chunk id only and refuses any other name", async () => {
    const dir = tmp();
    const c = new FileChunkCache(join(dir, "c"));
    for (const bad of ["../x", "a", "A".repeat(64), `${"a".repeat(63)}/`, ""]) {
      await expect(c.put(bad, new Uint8Array(1))).rejects.toBeInstanceOf(
        RangeError,
      );
      await expect(c.get(bad)).rejects.toBeInstanceOf(RangeError);
      await expect(c.delete(bad)).rejects.toBeInstanceOf(RangeError);
    }
    await c.put(id(1), new Uint8Array([9, 8, 7]));
    expect(readdirSync(join(dir, "c"))).toEqual([id(1)]);
    expect(statSync(join(dir, "c", id(1))).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "c")).mode & 0o777).toBe(0o700);
    expect(Array.from((await c.get(id(1)))!)).toEqual([9, 8, 7]);
    expect(await c.get(id(2))).toBeNull();
    await c.delete(id(1));
    expect(await c.get(id(1))).toBeNull();
  });

  it("keeps the newest within its budget, dropping the least recently used", async () => {
    const c = new FileChunkCache(join(tmp(), "c"), 30);
    await c.put(id(1), new Uint8Array(10));
    await c.put(id(2), new Uint8Array(10));
    await c.put(id(3), new Uint8Array(10));
    await c.get(id(1)); // 1 is now the newest
    await c.put(id(4), new Uint8Array(10)); // over the budget: 2 goes
    expect(await c.get(id(2))).toBeNull();
    expect(await c.get(id(1))).not.toBeNull();
    expect(await c.get(id(3))).not.toBeNull();
    expect(await c.get(id(4))).not.toBeNull();
    await c.put(id(5), new Uint8Array(31)); // bigger than the budget: not kept
    expect(await c.get(id(5))).toBeNull();
  });

  it("rebuilds its order and size from the directory after a restart", async () => {
    const dir = join(tmp(), "c");
    const a = new FileChunkCache(dir, 20);
    await a.put(id(1), new Uint8Array(10));
    await new Promise((r) => setTimeout(r, 20));
    await a.put(id(2), new Uint8Array(10));
    const b = new FileChunkCache(dir, 20);
    await b.put(id(3), new Uint8Array(10));
    expect(await b.get(id(1))).toBeNull();
    expect(await b.get(id(2))).not.toBeNull();
    expect(await b.get(id(3))).not.toBeNull();
  });

  it("treats a damaged entry as a miss and drops it; ignores strangers in the directory", async () => {
    const dir = join(tmp(), "c");
    const c = new FileChunkCache(dir);
    await c.put(id(1), new Uint8Array(10));
    writeFileSync(join(dir, id(1)), new Uint8Array(4)); // truncated behind our back
    expect(await c.get(id(1))).toBeNull();
    expect(existsSync(join(dir, id(1)))).toBe(false);
    writeFileSync(join(dir, "README"), "x");
    writeFileSync(join(dir, "dead.tmp"), "x");
    const fresh = new FileChunkCache(dir);
    expect(await fresh.get(id(2))).toBeNull();
    expect(existsSync(join(dir, "README"))).toBe(true);
    expect(existsSync(join(dir, "dead.tmp"))).toBe(false);
  });

  it("is scoped by hashes of the subject and the collection, and clear purges it", async () => {
    const root = tmp();
    const d1 = chunkCacheDir(root, "ps_a", "saves");
    expect(d1).not.toBe(chunkCacheDir(root, "ps_b", "saves"));
    expect(d1).not.toBe(chunkCacheDir(root, "ps_a", "notes"));
    expect(chunkCacheDir(root, "ps_a", "../../x").startsWith(root)).toBe(true);
    expect(chunkCacheDir(root, "ps_a", "../../x")).not.toContain("..");
    const c = new FileChunkCache(d1);
    await c.put(id(1), new Uint8Array(3));
    await c.clear();
    expect(existsSync(d1)).toBe(false);
    expect(await c.get(id(1))).toBeNull();
    await c.put(id(1), new Uint8Array(3));
    expect(await c.get(id(1))).not.toBeNull();
  });
});

// ── The engine over the Node parts, against a fake of the file routes ────────────────────────

interface Upload {
  mode: "single" | "multipart" | "chunks";
  size: number;
  sha256: string;
  format: "whole" | "chunks";
  partBytes?: number;
  parts: Map<number, Uint8Array>;
  single?: Uint8Array;
}

function fakeWorker(over: { partBytes?: number } = {}) {
  const uploads = new Map<string, Upload>();
  const chunks = new Map<string, Uint8Array>();
  let file: {
    version: number;
    bytes: Uint8Array;
    sha256: string;
    size: number;
    format: "whole" | "chunks";
  } | null = null;
  const stats = {
    partPuts: [] as number[],
    chunkPuts: 0,
    chunkGets: 0,
    failPart: null as number | null,
  };
  let n = 0;
  const handler: Handler = async (url, init, s) => {
    const p = url.pathname.replace(`/${PRODUCT}/sync/files/saves/`, "");
    const digestOk = (): boolean => {
      const want = /sha-256=:(.+):/.exec(s.headers.get("content-digest") ?? "");
      return (
        !!want &&
        !!s.body &&
        Buffer.from(want[1]!, "base64").toString("hex") === sha(s.body)
      );
    };
    const mismatch = () => json({ error: { code: "upload_mismatch" } }, 400);
    if (s.method === "POST" && p === "slot-1/begin") {
      const b = JSON.parse(String(init.body)) as Omit<
        Upload,
        "parts" | "mode"
      > & {
        format: "whole" | "chunks";
      };
      const mode =
        b.format === "chunks"
          ? "chunks"
          : over.partBytes
            ? "multipart"
            : "single";
      const id = `up${++n}`;
      uploads.set(id, {
        mode,
        size: b.size,
        sha256: b.sha256,
        format: b.format,
        ...(over.partBytes ? { partBytes: over.partBytes } : {}),
        parts: new Map(),
      });
      return json({
        uploadId: id,
        mode,
        ...(mode === "multipart" ? { partBytes: over.partBytes } : {}),
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      });
    }
    const up = /^slot-1\/upload\/([^/]+)(\/.*)?$/.exec(p);
    if (up) {
      const u = uploads.get(up[1]!);
      if (!u) return json({ error: { code: "upload_expired" } }, 410);
      const rest = up[2] ?? "";
      if (s.method === "GET" && rest === "")
        return json({
          mode: u.mode,
          size: u.size,
          ...(u.partBytes ? { partBytes: u.partBytes } : {}),
          received: [...u.parts.keys()],
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        });
      if (s.method === "DELETE") {
        uploads.delete(up[1]!);
        return new Response(null, { status: 204 });
      }
      if (s.method === "PUT" && rest === "") {
        if (!digestOk()) return mismatch();
        u.single = s.body!;
        return new Response(null, { status: 204 });
      }
      const part = /^\/parts\/(\d+)$/.exec(rest);
      if (s.method === "PUT" && part) {
        const k = Number(part[1]);
        stats.partPuts.push(k);
        if (stats.failPart === k) throw new Error("connection dropped");
        if (!digestOk()) return mismatch();
        u.parts.set(k, s.body!);
        return new Response(null, { status: 204 });
      }
      if (s.method === "POST" && rest === "/chunks") {
        const asked = (
          JSON.parse(String(init.body)) as { chunks: [string, number][] }
        ).chunks;
        return json({
          missing: asked.filter(([id]) => !chunks.has(id)).map(([id]) => id),
          present: asked.filter(([id]) => chunks.has(id)),
        });
      }
      const ch = /^\/chunks\/([0-9a-f]{64})$/.exec(rest);
      if (s.method === "PUT" && ch) {
        if (!digestOk()) return mismatch();
        stats.chunkPuts++;
        chunks.set(ch[1]!, s.body!);
        return new Response(null, { status: 204 });
      }
    }
    if (s.method === "POST" && p === "slot-1/finalize") {
      const u = uploads.get(
        (JSON.parse(String(init.body)) as { uploadId: string }).uploadId,
      );
      if (!u) return json({ error: { code: "upload_expired" } }, 410);
      let bytes: Uint8Array;
      if (u.mode === "multipart") {
        const total = Math.ceil(u.size / u.partBytes!);
        const missing = [...Array(total).keys()]
          .map((i) => i + 1)
          .filter((k) => !u.parts.has(k));
        if (missing.length)
          return json({ error: { code: "upload_incomplete" }, missing }, 409);
        bytes = Buffer.concat(
          [...u.parts.keys()].sort((a, b) => a - b).map((k) => u.parts.get(k)!),
        );
      } else bytes = u.single!;
      if (u.format === "whole" && sha(bytes) !== u.sha256) return mismatch();
      file = {
        version: (file?.version ?? 0) + 1,
        bytes,
        sha256: u.sha256,
        size: u.size,
        format: u.format,
      };
      return json({
        version: file.version,
        size: file.size,
        sha256: file.sha256,
        format: file.format,
      });
    }
    if (s.method === "GET" && p === "slot-1" && file) {
      const range = /bytes=(\d+)-(\d+)/.exec(s.headers.get("range") ?? "");
      const etag = `"${file.sha256}"`;
      if (!range)
        return new Response(file.bytes, { status: 200, headers: { etag } });
      const [a, b] = [Number(range[1]), Number(range[2])];
      return new Response(file.bytes.subarray(a, b + 1), {
        status: 206,
        headers: {
          etag,
          "content-range": `bytes ${a}-${Math.min(b, file.bytes.length - 1)}/${file.bytes.length}`,
        },
      });
    }
    const c = /^chunks\/([0-9a-f]{64})$/.exec(p);
    if (s.method === "GET" && c) {
      stats.chunkGets++;
      const held = chunks.get(c[1]!);
      return held
        ? new Response(held, { status: 200 })
        : json({ error: { code: "not_found" } }, 404);
    }
    return json({ error: { code: "not_found" } }, 404);
  };
  return { handler, stats, uploads, chunks };
}

const sink = (): ByteSink & { bytes: () => Uint8Array } => {
  const parts: Uint8Array[] = [];
  return {
    write: async (b) => void parts.push(Uint8Array.from(b)),
    bytes: () => new Uint8Array(Buffer.concat(parts)),
  };
};

const noSleep = { sleep: async () => undefined, random: () => 0 };

function engineRig() {
  const dir = tmp();
  const world = fakeWorker();
  const { transport } = rig(world.handler);
  const codec = serverFileCodec(webCryptoSyncPort);
  const engine = new TransferEngine({
    transport,
    journal: new FileJournal(dir),
    ...noSleep,
  });
  return { dir, world, codec, engine };
}

describe("the engine over the Node parts", () => {
  it("resumes a multipart upload from the journal on disk after a kill", async () => {
    const dir = tmp();
    const world = fakeWorker({ partBytes: 1_048_576 });
    const { transport } = rig(world.handler);
    const data = new Uint8Array(randomBytes(3 * 1_048_576 - 100));
    const req = {
      id: "save-1",
      collection: "saves",
      record: "slot-1",
      source: rangedBytes(data),
      size: data.length,
      sha256: sha(data),
      enc: "none" as const,
    };
    world.stats.failPart = 3;
    const first = new TransferEngine({
      transport,
      journal: new FileJournal(dir),
      maxAttempts: 2,
      ...noSleep,
    });
    await expect(first.upload(req)).rejects.toMatchObject({
      reason: "retries-exhausted",
    });
    const journal = new FileJournal(dir);
    expect(await journal.list()).toEqual(["save-1"]);
    expect(await journal.get("save-1")).toMatchObject({
      mode: "multipart",
      done: [1, 2],
      uploadId: "up1",
    });

    // A relaunch: a new engine, a new journal object over the same directory.
    world.stats.failPart = null;
    world.stats.partPuts.length = 0;
    const second = new TransferEngine({
      transport,
      journal: new FileJournal(dir),
      ...noSleep,
    });
    const done: FinalizeResponse = await second.upload(req);
    expect(world.stats.partPuts).toEqual([3]);
    expect(done).toMatchObject({
      version: 1,
      size: data.length,
      format: "whole",
    });
    expect(await new FileJournal(dir).list()).toEqual([]);

    const out = sink();
    await second.download({
      collection: "saves",
      record: "slot-1",
      format: "whole",
      size: done.size,
      sha256: done.sha256,
      codec: serverFileCodec(webCryptoSyncPort),
      sink: out,
    });
    expect(Buffer.from(out.bytes()).equals(Buffer.from(data))).toBe(true);
  });

  it("uploads a file as chunks, then a changed copy sends only the changed chunks; a second download hits the cache", async () => {
    const { dir, world, codec, engine } = engineRig();
    const data = new Uint8Array(randomBytes(4 * 1_048_576));
    const upload = (bytes: Uint8Array, id: string) =>
      engine.uploadChunked({
        id,
        collection: "saves",
        record: "slot-1",
        source: rangedBytes(bytes),
        codec,
      });
    const v1 = await upload(data, "w1");
    expect(v1).toMatchObject({ version: 1, format: "chunks" });
    const firstPuts = world.stats.chunkPuts;
    expect(firstPuts).toBeGreaterThan(4);

    const edited = Uint8Array.from(data);
    edited[2_000_000] = edited[2_000_000]! ^ 0xff;
    const v2 = await upload(edited, "w2");
    expect(v2.version).toBe(2);
    const changed = world.stats.chunkPuts - firstPuts;
    expect(changed).toBeGreaterThan(0);
    expect(changed).toBeLessThan(firstPuts / 2);

    const cache = new FileChunkCache(chunkCacheDir(dir, "ps_a", "saves"));
    const read = async () => {
      const out = sink();
      await engine.download({
        collection: "saves",
        record: "slot-1",
        format: "chunks",
        size: v2.size,
        sha256: v2.sha256,
        codec,
        cache,
        sink: out,
      });
      return out.bytes();
    };
    expect(Buffer.from(await read()).equals(Buffer.from(edited))).toBe(true);
    const fetched = world.stats.chunkGets;
    expect(fetched).toBeGreaterThan(0);
    expect(Buffer.from(await read()).equals(Buffer.from(edited))).toBe(true);
    expect(world.stats.chunkGets).toBe(fetched);
    for (const name of readdirSync(chunkCacheDir(dir, "ps_a", "saves")))
      expect(name).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a server that swaps a chunk is refused as file-invalid and is not cached", async () => {
    const { dir, world, codec, engine } = engineRig();
    const data = new Uint8Array(randomBytes(2 * 1_048_576));
    const v = await engine.uploadChunked({
      id: "w1",
      collection: "saves",
      record: "slot-1",
      source: rangedBytes(data),
      codec,
    });
    const [firstId, object] = [...world.chunks][0]!;
    const forged = Uint8Array.from(object);
    forged[forged.length - 1] = forged[forged.length - 1]! ^ 1;
    world.chunks.set(firstId, forged);
    const cache = new FileChunkCache(chunkCacheDir(dir, "ps_a", "saves"));
    await expect(
      engine.download({
        collection: "saves",
        record: "slot-1",
        format: "chunks",
        size: v.size,
        sha256: v.sha256,
        codec,
        cache,
        sink: sink(),
      }),
    ).rejects.toMatchObject({ reason: "file-invalid" });
    expect(await cache.get(firstId)).toBeNull();
  });
});

describe("shape", () => {
  it("the in-memory ports and the disk ports agree on a hit", async () => {
    const id = "b".repeat(64);
    const mem = memoryChunkCache();
    const disk = new FileChunkCache(join(tmp(), "c"));
    for (const c of [mem, disk]) {
      await c.put(id, new Uint8Array([1, 2]));
      expect(Array.from((await c.get(id))!)).toEqual([1, 2]);
    }
    vi.useRealTimers();
  });
});
