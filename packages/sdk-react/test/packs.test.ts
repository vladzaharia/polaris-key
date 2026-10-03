// @vitest-environment node
// `update.packs` for the web transport (P4-06 acceptance): a `files.tree` pack installed from a
// fake byte server through `createBrowserPacks`, with the in-memory store and with the OPFS store
// over an in-memory directory double (jsdom has no OPFS), the reload that re-verifies what OPFS
// holds, the boot's FETCH stage, wasm32's memory ceiling and the explicit refusal when OPFS is
// missing. A browser session cannot post `devices/report` (the registered web N/A), so the
// packSetId it would report is checked through `packSetId()`.
//
// @pkey-feature packs.state packs.handlers packs.record packs.revoke update.content packs.provides

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  bootTransition,
  initialBootState,
  packSetId,
  verifyRevocation,
  type BootEvent,
  type ZstdPort,
} from "@polaris-key/client-core";
import {
  decode as wasmDecode,
  decodeWithPrefix as wasmDecodeWithPrefix,
} from "@polaris-key/zstd-wasm";
import { loadZstdWasm } from "@polaris-key/zstd-wasm/browser";
import {
  WASM_MEM_BUDGET,
  createBrowserPacks,
  defaultWebMemBudget,
  hashWasmSha256,
  type BrowserPacksOptions,
  type DirHandle,
  type FileHandle,
} from "../src/update/index.js";
import {
  PRODUCT,
  PRODUCT_TRUST,
  PROBE_BASE,
  PROBE_TARGET,
  RELEASE_KEYS,
  byteServer,
  contentKeyPair,
  delegationFor,
  sha,
  stampFor,
  treePack,
  type TreePack,
  revocationFor,
} from "./packFixtures.js";
import { chunkStamp, containerPack, rangeServer } from "./chunkFixtures.js";

const BASE = "https://k.test";
const zstd: ZstdPort = {
  pointerBits: 30,
  decode: wasmDecode,
  decodeWithPrefix: wasmDecodeWithPrefix,
};

const discovery = {
  version: 2,
  protocolVersion: 4,
  product: PRODUCT,
  baseUrl: BASE,
  services: {
    release: {
      enabled: true,
      endpoints: { record: `${BASE}/${PRODUCT}/release/records/{sha256}` },
    },
    distribution: {
      enabled: true,
      endpoints: {
        blobs: `${BASE}/${PRODUCT}/distribution/blobs/sha256/{sha256}`,
      },
    },
  },
};

/** A credentialed-`fetch` stand-in over the fixture's byte server. */
function fakeFetch(server: ReturnType<typeof byteServer>) {
  const calls: { url: string; range: string | null; credentials?: string }[] =
    [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    calls.push({
      url: url.toString(),
      range: headers.get("range"),
      credentials: init?.credentials,
    });
    const rec = /\/release\/records\/([0-9a-f]{64})$/.exec(url.pathname);
    if (rec) {
      const r = await server.fetchRecord(rec[1]!);
      return r.ok ? new Response(r.body) : new Response("", { status: 404 });
    }
    const blob = /\/distribution\/blobs\/sha256\/([0-9a-f]{64})$/.exec(
      url.pathname,
    );
    if (blob) {
      const range = headers.get("range");
      const offset = range ? Number(/^bytes=(\d+)-$/.exec(range)?.[1] ?? 0) : 0;
      const o = await server.fetchObject({
        sha256: blob[1]!,
        offset,
        ifRange: headers.get("if-range"),
      });
      const parts: Uint8Array[] = [];
      for await (const c of o.chunks) parts.push(c);
      return new Response(Buffer.concat(parts), {
        status: o.status,
        headers: o.contentRange ? { "content-range": o.contentRange } : {},
      });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { impl, calls };
}

/** An in-memory `FileSystemDirectoryHandle` double: just the calls `opfsPackStore` makes. */
/** Names whose handles fail with a non-NotFound error (an unreadable entry). */
const unreadable = new Set<string>();
function memoryDir(name = ""): DirHandle {
  const dirs = new Map<string, DirHandle>();
  const files = new Map<string, { bytes: Uint8Array }>();
  const fileHandle = (n: string): FileHandle => ({
    kind: "file",
    name: n,
    async getFile() {
      const b = files.get(n)!.bytes;
      return {
        size: b.byteLength,
        slice: (a: number, z: number) => ({
          arrayBuffer: async () => b.slice(a, z).buffer as ArrayBuffer,
        }),
      };
    },
    async createWritable(opts?: { keepExistingData?: boolean }) {
      let buf = opts?.keepExistingData
        ? files.get(n)!.bytes.slice()
        : new Uint8Array();
      return {
        async write(
          d: { type: "write"; position: number; data: Uint8Array } | Uint8Array,
        ) {
          const pos = d instanceof Uint8Array ? 0 : d.position;
          const data = d instanceof Uint8Array ? d : d.data;
          const next = new Uint8Array(
            Math.max(buf.byteLength, pos + data.byteLength),
          );
          next.set(buf);
          next.set(data, pos);
          buf = next;
        },
        async truncate(size: number) {
          buf = buf.slice(0, size);
        },
        async close() {
          files.get(n)!.bytes = buf;
        },
      };
    },
  });
  const self: DirHandle = {
    kind: "directory",
    name,
    async getDirectoryHandle(n, opts) {
      if (unreadable.has(n))
        throw new DOMException("cannot read", "NotReadableError");
      if (!dirs.has(n)) {
        if (!opts?.create || files.has(n))
          throw new DOMException("not found", "NotFoundError");
        dirs.set(n, memoryDir(n));
      }
      return dirs.get(n)!;
    },
    async getFileHandle(n, opts) {
      if (unreadable.has(n))
        throw new DOMException("cannot read", "NotReadableError");
      if (!files.has(n)) {
        if (!opts?.create || dirs.has(n))
          throw new DOMException("not found", "NotFoundError");
        files.set(n, { bytes: new Uint8Array() });
      }
      return fileHandle(n);
    },
    async removeEntry(n) {
      if (!dirs.delete(n) && !files.delete(n))
        throw new DOMException("not found", "NotFoundError");
    },
    async *entries() {
      for (const [n, d] of dirs) yield [n, d] as [string, DirHandle];
      for (const n of files.keys())
        yield [n, fileHandle(n)] as [string, FileHandle];
    },
  };
  return self;
}

const v1Files = {
  "fr/strings.json": '{"hello":"bonjour"}',
  "fr/menu.json": '{"play":"jouer"}',
  "probe.txt": PROBE_BASE,
  "big.bin": "x".repeat(60000),
};

function packs(
  server: ReturnType<typeof byteServer>,
  stamp: TreePack[],
  extra: Partial<BrowserPacksOptions> = {},
) {
  const f = fakeFetch(server);
  return {
    calls: f.calls,
    p: createBrowserPacks({
      baseUrl: BASE,
      product: PRODUCT,
      discovery: discovery as never,
      releaseKeys: RELEASE_KEYS,
      productTrust: PRODUCT_TRUST,
      contentStamp: JSON.stringify({
        format: "pkey-content/1",
        ...stampFor(...stamp),
      }),
      fetchImpl: f.impl,
      zstd,
      storage: "memory",
      ...extra,
    }),
  };
}

describe("createBrowserPacks (update.packs, web)", () => {
  it("installs a files.tree pack over credentialed fetch into the in-memory store", async () => {
    const v1 = await treePack({
      packId: "djdl.l10n",
      version: "1.0.0",
      seq: 1,
      files: v1Files,
    });
    const { p, calls } = packs(byteServer(v1), [v1]);
    const phases: string[] = [];
    p.on((e) => phases.push(e.phase));
    const [i] = await p.ensure(["djdl.l10n"]);
    expect(i!.recordSha256).toBe(v1.recordSha256);
    expect(
      new TextDecoder().decode(
        (await p.readFile("djdl.l10n", "fr/strings.json"))!,
      ),
    ).toBe('{"hello":"bonjour"}');
    expect(await p.readFile("djdl.l10n", "nope")).toBeNull();
    expect(phases).toContain("done");
    expect(calls.every((c) => c.credentials === "include")).toBe(true);
    expect(await p.packSetId()).toBe(
      await packSetId([
        { packId: "djdl.l10n", releaseSha256: v1.recordSha256 },
      ]),
    );
  });

  it("answers isAvailable from the active set and packFor from the stamp's pins (P4-20)", async () => {
    const l10n = await treePack({
      packId: "djdl.l10n",
      version: "1.0.0",
      seq: 1,
      files: v1Files,
      recordExtra: { provides: ["l10n.fr"] },
    });
    const foes = await treePack({
      packId: "djdl.foes",
      version: "2.0.0",
      seq: 4,
      files: { "foes.json": "{}" },
      recordExtra: { provides: ["foe.goblin"] },
    });
    const { p } = packs(byteServer(l10n, foes), [l10n, foes]);
    expect(await p.isAvailable("l10n.fr")).toBe(false);
    await p.ensure(["djdl.l10n"]);
    expect(await p.isAvailable("l10n.fr")).toBe(true);
    expect(await p.isAvailable("foe.goblin")).toBe(false);
    expect(await p.packFor("foe.goblin")).toEqual({
      packId: "djdl.foes",
      release: { sha256: foes.recordSha256, seq: 4, version: "2.0.0" },
    });
    expect(await p.packFor("foe.dragon")).toBeNull();
  });

  it("persists in OPFS: a reload re-verifies, an evicted payload is re-planned from scratch", async () => {
    const v1 = await treePack({
      packId: "djdl.l10n",
      version: "1.0.0",
      seq: 1,
      files: v1Files,
    });
    const root = memoryDir();
    const server = byteServer(v1);
    const a = packs(server, [v1], { storage: "opfs", opfsRoot: root });
    await a.p.ensure(["djdl.l10n"]);

    const b = packs(server, [v1], { storage: "opfs", opfsRoot: root });
    expect((await b.p.state()).active["djdl.l10n"]!.recordSha256).toBe(
      v1.recordSha256,
    );
    await b.p.ensure(["djdl.l10n"]);
    expect(b.calls.filter((c) => c.url.includes("/blobs/"))).toEqual([]);

    // Evict the stored payload: the reload drops it and the next ensure fetches again.
    const packsDir = await (
      await (
        await root.getDirectoryHandle("polaris-key")
      ).getDirectoryHandle(PRODUCT)
    ).getDirectoryHandle("packs");
    await packsDir.removeEntry("store", { recursive: true });
    const c = packs(server, [v1], { storage: "opfs", opfsRoot: root });
    expect((await c.p.state()).active["djdl.l10n"]).toBeUndefined();
    await c.p.ensure(["djdl.l10n"]);
    expect(c.calls.some((x) => x.url.endsWith(v1.fullSha256))).toBe(true);
    expect(
      new TextDecoder().decode(
        (await c.p.readFile("djdl.l10n", "fr/menu.json"))!,
      ),
    ).toBe('{"play":"jouer"}');
  });

  it("updates through a files delta set (the probe frame) under the WASM decoder", async () => {
    const v1 = await treePack({
      packId: "djdl.l10n",
      version: "1.0.0",
      seq: 1,
      files: v1Files,
    });
    const v2 = await treePack({
      packId: "djdl.l10n",
      version: "1.1.0",
      seq: 2,
      files: { ...v1Files, "probe.txt": PROBE_TARGET, "fr/new.json": "{}" },
      from: v1,
    });
    const root = memoryDir();
    const server = byteServer(v1, v2);
    await packs(server, [v1], { storage: "opfs", opfsRoot: root }).p.ensure([
      "djdl.l10n",
    ]);
    const up = packs(server, [v2], { storage: "opfs", opfsRoot: root });
    const [i] = await up.p.ensure(["djdl.l10n"]);
    expect(i!.version).toBe("1.1.0");
    expect(sha((await up.p.readFile("djdl.l10n", "probe.txt"))!)).toBe(
      sha(PROBE_TARGET),
    );
  });

  it("caps the delta memory budget at 2^30 (wasm32: P = 30)", async () => {
    expect(WASM_MEM_BUDGET).toBe(2 ** 30);
    const v1 = await treePack({
      packId: "djdl.l10n",
      version: "1.0.0",
      seq: 1,
      files: v1Files,
    });
    const v2 = await treePack({
      packId: "djdl.l10n",
      version: "1.1.0",
      seq: 2,
      files: { ...v1Files, "probe.txt": PROBE_TARGET },
      from: v1,
      memBytes: 2 ** 30 + 1,
    });
    const server = byteServer(v1, v2);
    const root = memoryDir();
    await packs(server, [v1], { storage: "opfs", opfsRoot: root }).p.ensure([
      "djdl.l10n",
    ]);
    const up = packs(server, [v2], {
      storage: "opfs",
      opfsRoot: root,
      memBudget: 2 ** 31,
    });
    await up.p.ensure(["djdl.l10n"]);
    // The delta needs more than 2^30, so the clamped budget drops it: no descriptor fetched.
    const patchFetched = up.calls.some((c) =>
      [...v2.objects.keys()].some(
        (h) =>
          c.url.endsWith(h) &&
          !v1.objects.has(h) &&
          h !== v2.indexSha256 &&
          h !== v2.fullSha256 &&
          h !== sha(PROBE_TARGET),
      ),
    );
    expect(patchFetched).toBe(false);
  });

  it("drives the boot's FETCH stage (the stage machine's host side)", async () => {
    const v1 = await treePack({
      packId: "djdl.l10n",
      version: "1.0.0",
      seq: 1,
      files: v1Files,
    });
    const { p } = packs(byteServer(v1), [v1]);
    let state = initialBootState(p.bootOptions());
    const emits: string[] = [];
    const send = (e: BootEvent) => {
      const t = bootTransition(state, e);
      state = t.state;
      emits.push(...t.emits.map((x) => x.type));
    };
    for (const e of [
      { type: "start" },
      { type: "shell.done" },
      { type: "guard.done", result: "ok" },
      { type: "sync.done", result: "ok" },
      { type: "gate.status", status: "ok" },
      { type: "decide.done", decision: "none" },
    ] as BootEvent[])
      send(e);
    const r = await p.bootFetch({ send, consent: "never" });
    expect(r).toEqual({ result: "ok", installed: ["djdl.l10n"] });
    expect(state.stage).toBe("mount");
    expect(emits).toContain("fetch_progress");
  });

  it("refuses explicitly when OPFS is missing, and without a stamp", async () => {
    const v1 = await treePack({
      packId: "djdl.l10n",
      version: "1.0.0",
      seq: 1,
      files: v1Files,
    });
    const { p } = packs(byteServer(v1), [v1], { storage: "opfs" });
    await expect(p.ensure(["djdl.l10n"])).rejects.toMatchObject({
      code: "not-configured",
    });
    const none = packs(byteServer(v1), [v1], { contentStamp: null }).p;
    await expect(none.ensure(["djdl.l10n"])).rejects.toMatchObject({
      code: "not-configured",
    });
    expect(await none.packSetId()).toBeNull();
    expect(() => packs(byteServer(v1), [v1], { contentStamp: "{}" })).toThrow();
  });
});

// @pkey-feature packs.apply.chunk packs.index.chunks
describe("createBrowserPacks and chunk sync in OPFS (P4-11)", () => {
  const BLOB = {
    type: "custom.blob",
    layout: "container" as const,
    activation: "restart" as const,
    supports: (v: number) => v === 1,
  };
  /** A credentialed-`fetch` stand-in over the chunk fixtures' range server. */
  function rangeFetch(server: ReturnType<typeof rangeServer>) {
    const calls: {
      url: string;
      range: string | null;
      ifRange: string | null;
    }[] = [];
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      calls.push({
        url: url.toString(),
        range: headers.get("range"),
        ifRange: headers.get("if-range"),
      });
      const rec = /\/release\/records\/([0-9a-f]{64})$/.exec(url.pathname);
      if (rec) {
        const r = await server.fetchRecord(rec[1]!);
        return r.ok ? new Response(r.body) : new Response("", { status: 404 });
      }
      const blob = /\/distribution\/blobs\/sha256\/([0-9a-f]{64})$/.exec(
        url.pathname,
      );
      if (blob) {
        const m = /^bytes=(\d+)-(\d*)$/.exec(headers.get("range") ?? "");
        const o = await server.fetchObject({
          sha256: blob[1]!,
          offset: m ? Number(m[1]) : 0,
          ...(m && m[2] !== ""
            ? { length: Number(m[2]) - Number(m[1]) + 1 }
            : {}),
          ifRange: headers.get("if-range"),
        });
        const parts: Uint8Array[] = [];
        try {
          for await (const c of o.chunks) parts.push(c);
        } catch {
          // A cut body: the stream errors after what was sent.
          const body = new ReadableStream<Uint8Array>({
            start(ctl) {
              ctl.enqueue(Buffer.concat(parts));
              ctl.error(new TypeError("network error"));
            },
          });
          return new Response(body, {
            status: o.status,
            headers: {
              ...(o.contentRange ? { "content-range": o.contentRange } : {}),
              ...(o.etag ? { etag: o.etag } : {}),
            },
          });
        }
        return new Response(Buffer.concat(parts), {
          status: o.status,
          headers: {
            ...(o.contentRange ? { "content-range": o.contentRange } : {}),
            ...(o.etag ? { etag: o.etag } : {}),
          },
        });
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;
    return { impl, calls };
  }

  it("installs v2 by chunk over OPFS in the planner's runs, and resumes a cut run", async () => {
    const v1 = await containerPack({
      packId: "djdl.levels",
      version: "1.0.0",
      seq: 1,
      chunks: ["a", "b", "c", "d", "e", "f"],
      bundles: [["a", "b", "c", "d", "e", "f"]],
    });
    const v2 = await containerPack({
      packId: "djdl.levels",
      version: "1.1.0",
      seq: 2,
      chunks: ["a", "g", "c", "h", "i", "f", "j"],
      bundles: [
        ["a", "b", "c", "d", "e", "f"],
        ["g", null, "h", "i", null, "j"],
      ],
    });
    const server = rangeServer(v1, v2);
    const root = memoryDir();
    const make = () => {
      const f = rangeFetch(server);
      return {
        calls: f.calls,
        p: createBrowserPacks({
          baseUrl: BASE,
          product: PRODUCT,
          discovery: discovery as never,
          releaseKeys: RELEASE_KEYS,
          productTrust: PRODUCT_TRUST,
          contentStamp: JSON.stringify({
            format: "pkey-content/1",
            ...chunkStamp(v1),
          }),
          fetchImpl: f.impl,
          zstd,
          storage: "opfs",
          opfsRoot: root,
          handlers: [BLOB],
        }),
      };
    };
    const a = make();
    await a.p.ensure([v1.packId]);
    const t = {
      pack: v2.packId,
      release: { sha256: v2.recordSha256, seq: 2, version: "1.1.0" },
    };
    server.cutRange = 2;
    await expect(a.p.ensureReleases([t])).rejects.toMatchObject({
      code: "network-error",
    });
    const bounded = (calls: { range: string | null }[]) =>
      calls
        .filter((c) => c.range !== null && /-\d+$/.test(c.range))
        .map((c) => c.range);
    expect(bounded(a.calls)).toEqual(["bytes=0-65535", "bytes=131072-262143"]);

    server.cutRange = 0;
    const b = make();
    const [install] = await b.p.ensureReleases([t]);
    expect(install!.payloadSha256).toBe(sha(v2.payload));
    expect(bounded(b.calls)).toEqual([
      "bytes=131072-262143",
      "bytes=327680-393215",
    ]);
    expect(b.calls.every((c) => c.range === null || c.ifRange !== null)).toBe(
      true,
    );
    expect(b.calls.some((c) => c.url.endsWith(sha(v2.payload)))).toBe(false);
  });
});

describe("the browser ports", () => {
  it("hash-wasm streams SHA-256 like node:crypto, fed before and after it is ready", async () => {
    const h = hashWasmSha256();
    h.update(new TextEncoder().encode("hello "));
    await new Promise((r) => setTimeout(r, 0));
    h.update(new TextEncoder().encode("world"));
    expect(await h.digest()).toBe(
      createHash("sha256").update("hello world").digest("hex"),
    );
  });

  it("the zstd-wasm browser entry compiles the committed module and decodes the probe", async () => {
    const require = createRequire(import.meta.url);
    const wasm = readFileSync(
      require.resolve("@polaris-key/zstd-wasm/zdec.wasm"),
    );
    const z = await loadZstdWasm(new Uint8Array(wasm));
    expect(z.version()).toBe(10507);
    const { PROBE_FRAME } = await import("./packFixtures.js");
    expect(
      sha(
        z.decodeWithPrefix(
          PROBE_FRAME,
          PROBE_BASE,
          PROBE_TARGET.byteLength,
          10,
        ),
      ),
    ).toBe(sha(PROBE_TARGET));
  });
});

describe("the OPFS store's commit marker", () => {
  it("never uses a store directory whose copy did not complete", async () => {
    const v1 = await treePack({
      packId: "djdl.l10n",
      version: "1.0.0",
      seq: 1,
      files: v1Files,
    });
    const root = memoryDir();
    const server = byteServer(v1);
    const a = packs(server, [v1], { storage: "opfs", opfsRoot: root });
    const [i] = await a.p.ensure(["djdl.l10n"]);
    // Drop the marker: the directory now looks like a copy interrupted by quota or a crash.
    const parts = [
      "polaris-key",
      PRODUCT,
      "packs",
      ...i!.location.split("/"),
      ".pkey",
    ];
    let d = root;
    for (const p of parts) d = await d.getDirectoryHandle(p);
    await d.removeEntry("committed");
    const b = packs(server, [v1], { storage: "opfs", opfsRoot: root });
    expect((await b.p.state()).active["djdl.l10n"]).toBeUndefined();
    await b.p.ensure(["djdl.l10n"]);
    expect(b.calls.some((x) => x.url.endsWith(v1.fullSha256))).toBe(true);
    expect(
      new TextDecoder().decode(
        (await b.p.readFile("djdl.l10n", "fr/strings.json"))!,
      ),
    ).toBe('{"hello":"bonjour"}');
  });
});

describe("the web memory budget and the state document", () => {
  it("derives the default budget from navigator.deviceMemory, clamped, with 2^30 the ceiling", () => {
    expect(defaultWebMemBudget(8)).toBe(2 ** 30);
    expect(defaultWebMemBudget(2)).toBe(2 ** 29);
    expect(defaultWebMemBudget(0.25)).toBe(64 * 1024 * 1024);
    expect(defaultWebMemBudget(NaN)).toBe(256 * 1024 * 1024);
  });

  it("refuses a full payload whose frame plus output exceeds the budget, cleanly", async () => {
    const v1 = await treePack({
      packId: "djdl.l10n",
      version: "1.0.0",
      seq: 1,
      files: v1Files,
    });
    const { p, calls } = packs(byteServer(v1), [v1], { memBudget: 1000 });
    await expect(p.ensure(["djdl.l10n"])).rejects.toMatchObject({
      code: "plan-no-strategy",
    });
    expect(calls.some((c) => c.url.endsWith(v1.fullSha256))).toBe(false);
  });

  it("holds a torn OPFS state document aside and keeps the store", async () => {
    const v1 = await treePack({
      packId: "djdl.l10n",
      version: "1.0.0",
      seq: 1,
      files: v1Files,
    });
    const root = memoryDir();
    const server = byteServer(v1);
    const [i] = await packs(server, [v1], {
      storage: "opfs",
      opfsRoot: root,
    }).p.ensure(["djdl.l10n"]);
    const dir = await (
      await (
        await root.getDirectoryHandle("polaris-key")
      ).getDirectoryHandle(PRODUCT)
    ).getDirectoryHandle("packs");
    const w = await (await dir.getFileHandle("state.json")).createWritable();
    await w.write(new TextEncoder().encode('{"v":1,"act'));
    await w.close();
    for (let n = 0; n < 2; n++) {
      const b = packs(server, [v1], { storage: "opfs", opfsRoot: root });
      expect((await b.p.state()).stateIssue).toBe("torn");
    }
    await dir.getFileHandle("state.json.torn");
    let store = dir;
    for (const part of i!.location.split("/"))
      store = await store.getDirectoryHandle(part);
    expect(store).toBeDefined();
  });
});

describe("an OPFS entry the page cannot read", () => {
  it("is never mistaken for missing: two loads keep the install", async () => {
    const v1 = await treePack({
      packId: "djdl.l10n",
      version: "1.0.0",
      seq: 1,
      files: v1Files,
    });
    const root = memoryDir();
    const server = byteServer(v1);
    const [i] = await packs(server, [v1], {
      storage: "opfs",
      opfsRoot: root,
    }).p.ensure(["djdl.l10n"]);
    const version = i!.location.split("/").at(-1)!;
    unreadable.add(version);
    try {
      for (let n = 0; n < 2; n++) {
        const b = packs(server, [v1], { storage: "opfs", opfsRoot: root });
        const s = await b.p.state();
        expect(s.active["djdl.l10n"]).toBeUndefined();
        expect(s.running["djdl.l10n"]).toBeUndefined();
      }
    } finally {
      unreadable.delete(version);
    }
    const c = packs(server, [v1], { storage: "opfs", opfsRoot: root });
    expect((await c.p.state()).active["djdl.l10n"]!.location).toBe(i!.location);
    await c.p.ensure(["djdl.l10n"]);
    expect(c.calls.filter((x) => x.url.includes("/blobs/"))).toEqual([]);
  });
});

describe("createBrowserPacks and revocations (plans/P4-13.md §2.5)", () => {
  it("gives the update check its content input and keeps the revocations it verified", async () => {
    const v1 = await treePack({
      packId: "djdl.l10n",
      version: "1.0.0",
      seq: 1,
      files: v1Files,
    });
    const { p } = packs(byteServer(v1), [v1]);
    await p.ensure(["djdl.l10n"]);
    const before = await p.contentInput();
    expect(before?.holds).toEqual([]);
    expect(before?.active["djdl.l10n"]?.sha256).toBe(v1.recordSha256);
    expect(before?.revoked).toEqual({});
    const rev = await revocationFor(v1);
    const v = await verifyRevocation(rev.jws, {
      releaseKeys: RELEASE_KEYS,
      productTrust: PRODUCT_TRUST,
      expectedAud: PRODUCT,
      entry: rev.entry,
    });
    if (!v.ok) throw new Error("fixture");
    await p.recordRevocations({
      learned: [{ revocation: v.revocation, jws: rev.jws }],
      relearnCleared: [],
    });
    expect(Object.keys((await p.revocations()).revoked)).toEqual([
      v1.recordSha256,
    ]);
    expect((await p.state()).running["djdl.l10n"]).toBeUndefined();
    await expect(p.ensure(["djdl.l10n"])).rejects.toMatchObject({
      code: "pack-revoked",
    });
    expect(Object.keys((await p.contentInput())!.revoked)).toEqual([
      v1.recordSha256,
    ]);
  });
});

describe("createBrowserPacks and delegated releases (plans/P4-19.md §2.4)", () => {
  it("refuses a held release signed under a delegation through the packs facet; unheld, it installs", async () => {
    const ck = contentKeyPair();
    const d = await delegationFor({
      deliverable: "djdl.events",
      publicKey: ck.pub,
    });
    const held = await treePack({
      packId: "djdl.events.halloween",
      version: "1.0.0",
      seq: 1,
      files: { "a.json": "{}" },
      issuedAt: 1759250000,
      signer: { pem: ck.pem, kid: d.kid },
    });
    const server = byteServer(held);
    const records = server.fetchRecord;
    server.fetchRecord = async (h: string) =>
      h === d.sha256 ? ({ ok: true, body: d.jws } as const) : records(h);
    const release = {
      sha256: held.recordSha256,
      seq: held.seq,
      version: held.version,
    };
    const expects = [
      { pack: held.packId, required: true, delivery: "essential" },
    ];
    const target = { pack: held.packId, release };
    const now = () => 1759400000;

    // A byte or string stamp: its holds reach the engine, which refuses the delegated path.
    const heldStamp = JSON.stringify({
      format: "pkey-content/1",
      contentApi: 1,
      pins: [],
      expects,
      holds: [{ pack: held.packId, release, reason: "held in a test" }],
    });
    for (const contentStamp of [
      heldStamp,
      new TextEncoder().encode(heldStamp),
    ]) {
      const { p } = packs(server, [], { contentStamp, now });
      await expect(p.ensureReleases([target])).rejects.toMatchObject({
        code: "record-rejected",
        detail: "jws",
      });
    }

    // Without the hold the same target installs through its delegation.
    const { p } = packs(server, [], {
      contentStamp: JSON.stringify({
        format: "pkey-content/1",
        contentApi: 1,
        pins: [],
        expects,
      }),
      now,
    });
    const [install] = await p.ensureReleases([target]);
    expect(install!.delegation).toBe(d.jws);
  });
});
