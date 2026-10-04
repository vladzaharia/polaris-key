// @vitest-environment node
// The browser's native payload transport (P4-18): the payload URL derived from discovery's blob
// template, the `?via=dcz` guard, what is never attempted (a gated pack, a base over 100 MiB, a
// base that is not installed), the streaming write and its measurement, the OPFS worker's
// `fetchInto`, and the whole chain through `createBrowserPacks`: a container's v1 over the
// payload URL, v2 over dcz, and the WASM delta over the blob route when dcz is declined. The
// Chromium job (conformance/runners/browser/dcz.browser.test.ts) runs the same chain against a
// real browser's HTTP cache and Compression Dictionary Transport.
//
// @pkey-feature packs.apply.delta packs.apply.full

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { signJws } from "@polaris-key/jws";
import {
  decode as wasmDecode,
  decodeWithPrefix as wasmDecodeWithPrefix,
} from "@polaris-key/zstd-wasm";
import type {
  NativePayloadRequest,
  PackHandler,
  PackProgress,
  ZstdPort,
} from "@polaris-key/client-core";
import type { PackVariant } from "@polaris-key/protocol/packs";
import { createBrowserPacks } from "../src/packs/browserPacks.js";
import {
  MAX_DICTIONARY_BYTES,
  browserNativePayload,
  payloadUrlTemplate,
  type NativePayloadEvent,
} from "../src/packs/nativePayload.js";
import { workerIo, type WorkerLike } from "../src/packs/opfsIo.js";
import {
  PRODUCT,
  PRODUCT_TRUST,
  PROBE_BASE,
  PROBE_FRAME,
  PROBE_TARGET,
  RELEASE_KEYS,
  RELEASE_KID,
} from "./packFixtures.js";

const here = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(
  readFileSync(
    join(here, "..", "..", "..", "conformance", "corpus", "v2", "cases.json"),
    "utf8",
  ),
) as { keys: { kid: string; privateKeyPkcs8Pem: string }[] };
const releasePem = corpus.keys.find(
  (k) => k.kid === RELEASE_KID,
)!.privateKeyPkcs8Pem;

const sha = (b: Uint8Array | string): string =>
  createHash("sha256").update(b).digest("hex");
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const sha256Port = () => {
  const h = createHash("sha256");
  return {
    update: (b: Uint8Array) => void h.update(b),
    digest: () => h.digest("hex"),
  };
};

const BASE = "https://key.example.test";
const BYTES = "https://dl.example.test";
const PACK = "djdl.levels";
const BLOBS = `${BYTES}/${PRODUCT}/distribution/blobs/sha256/{sha256}`;

const zstd: ZstdPort = {
  pointerBits: 30,
  decode: wasmDecode,
  decodeWithPrefix: wasmDecodeWithPrefix,
};

const BLOB: PackHandler = {
  type: "custom.blob",
  layout: "container",
  activation: "hot",
  supports: (v) => v === 1,
};

interface Release {
  version: string;
  seq: number;
  jws: string;
  recordSha256: string;
  payload: Uint8Array;
  objects: Map<string, Uint8Array>;
  variant: PackVariant;
}

async function release(o: {
  version: string;
  seq: number;
  payload: Uint8Array;
  delta?: { from: Uint8Array; frame: Uint8Array };
  entitlement?: string;
}): Promise<Release> {
  const { payload } = o;
  const index = enc(
    JSON.stringify({
      format: "pkey-files/1",
      layout: "container",
      payload: { size: payload.byteLength, sha256: sha(payload) },
      files: [
        {
          path: "data.bin",
          offset: 0,
          size: payload.byteLength,
          sha256: sha(payload),
          blob: {
            sha256: sha(payload),
            bytes: payload.byteLength,
            codec: "none",
          },
        },
      ],
    }),
  );
  const gaps = new Uint8Array();
  const objects = new Map<string, Uint8Array>([
    [sha(payload), payload],
    [sha(index), index],
    [sha(gaps), gaps],
  ]);
  if (o.delta) objects.set(sha(o.delta.frame), o.delta.frame);
  const variant = {
    variant: {},
    payload: { size: payload.byteLength, sha256: sha(payload) },
    full: {
      sha256: sha(payload),
      bytes: payload.byteLength,
      size: payload.byteLength,
      codec: "none",
    },
    files: {
      format: "pkey-files/1",
      layout: "container",
      sha256: sha(index),
      bytes: index.byteLength,
      size: index.byteLength,
      codec: "none",
      gaps: { sha256: sha(gaps), bytes: 0, size: 0, codec: "none" },
    },
    ...(o.delta
      ? {
          deltas: [
            {
              method: "zstd-patch-from",
              scope: "payload" as const,
              from: sha(o.delta.from),
              memBytes: o.delta.from.byteLength + payload.byteLength,
              artifact: {
                sha256: sha(o.delta.frame),
                bytes: o.delta.frame.byteLength,
              },
            },
          ],
        }
      : {}),
  };
  const jws = await signJws(
    {
      schemaVersion: 1,
      aud: PRODUCT,
      deliverable: PACK,
      kind: "pack",
      version: o.version,
      seq: o.seq,
      issuedAt: 1759300000 + o.seq,
      type: "custom.blob",
      formatVersion: 1,
      handler: { activation: "hot" },
      ...(o.entitlement ? { entitlement: o.entitlement } : {}),
      variants: [variant],
    },
    releasePem,
    RELEASE_KID,
    "pkey-release+jws",
  );
  return {
    version: o.version,
    seq: o.seq,
    jws,
    recordSha256: sha(jws),
    payload,
    objects,
    variant: variant as unknown as PackVariant,
  };
}

function nativeReq(
  r: Release,
  o: Partial<NativePayloadRequest> & { written?: Uint8Array[] } = {},
): NativePayloadRequest {
  const written = o.written ?? [];
  return {
    packId: PACK,
    planId: "plan-1",
    variant: r.variant,
    delta: null,
    base: null,
    gated: false,
    sink: { write: async (_at, b) => void written.push(b.slice()) },
    onBytes: () => undefined,
    ...o,
  };
}

describe("the payload URL template (P4-18)", () => {
  it("is the blob route's sibling on the same host, from the canonical blob template only", () => {
    expect(payloadUrlTemplate(BLOBS)).toBe(
      `${BYTES}/${PRODUCT}/distribution/packs/{pack}/{variant}/payload/{sha256}`,
    );
    expect(
      payloadUrlTemplate(`${BASE}/acme/distribution/blobs/sha256/{sha256}`),
    ).toBe(`${BASE}/acme/distribution/packs/{pack}/{variant}/payload/{sha256}`);
    expect(
      payloadUrlTemplate(`${BYTES}/djdl/release/blobs/sha256/{sha256}`),
    ).toBeNull();
    expect(payloadUrlTemplate(null)).toBeNull();
  });
});

describe("browserNativePayload (P4-18)", () => {
  function port(
    respond: (url: string) => Response | Promise<Response>,
    extra: Partial<Parameters<typeof browserNativePayload>[0]> = {},
  ) {
    const urls: string[] = [];
    const events: NativePayloadEvent[] = [];
    const p = browserNativePayload({
      template: () => payloadUrlTemplate(BLOBS),
      baseUrl: BASE,
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        urls.push(String(input));
        expect(init?.credentials).toBe("omit");
        return respond(String(input));
      }) as typeof fetch,
      sha256: sha256Port,
      onEvent: (e) => events.push(e),
      ...extra,
    });
    return { p, urls, events };
  }

  it("asks the target's payload URL for a whole payload, and with ?via=dcz for a delta", async () => {
    const v2 = await release({
      version: "1.1.0",
      seq: 2,
      payload: PROBE_TARGET,
      delta: { from: PROBE_BASE, frame: PROBE_FRAME },
    });
    const { p, urls } = port(() => new Response(Buffer.from(PROBE_TARGET)));
    const written: Uint8Array[] = [];
    expect(await p(nativeReq(v2, { written }))).toEqual({
      ok: true,
      size: PROBE_TARGET.byteLength,
      sha256: sha(PROBE_TARGET),
    });
    expect(Buffer.concat(written)).toEqual(Buffer.from(PROBE_TARGET));
    const delta = v2.variant.deltas![0]! as never;
    await p(
      nativeReq(v2, {
        delta,
        base: { sha256: sha(PROBE_BASE), size: PROBE_BASE.byteLength },
      }),
    );
    expect(urls).toEqual([
      `${BYTES}/${PRODUCT}/distribution/packs/${PACK}/default/payload/${sha(PROBE_TARGET)}`,
      `${BYTES}/${PRODUCT}/distribution/packs/${PACK}/default/payload/${sha(PROBE_TARGET)}?via=dcz`,
    ]);
  });

  it("names a varied pack's variant by its key", async () => {
    const v1 = await release({ version: "1.0.0", seq: 1, payload: PROBE_BASE });
    const { p, urls } = port(() => new Response(Buffer.from(PROBE_BASE)));
    await p(
      nativeReq(v1, {
        variant: { ...v1.variant, variant: { texture: "s3tc", locale: "fr" } },
      }),
    );
    expect(urls[0]).toContain(`/packs/${PACK}/locale=fr;texture=s3tc/payload/`);
  });

  it("never asks for dcz when it cannot happen: a gated pack, a base over 100 MiB, no base, no template", async () => {
    const v2 = await release({
      version: "1.1.0",
      seq: 2,
      payload: PROBE_TARGET,
      delta: { from: PROBE_BASE, frame: PROBE_FRAME },
    });
    const delta = v2.variant.deltas![0]! as never;
    const base = { sha256: sha(PROBE_BASE), size: PROBE_BASE.byteLength };
    const { p, urls } = port(() => new Response(Buffer.from(PROBE_TARGET)));
    expect(await p(nativeReq(v2, { delta, base, gated: true }))).toBeNull();
    expect(
      await p(
        nativeReq(v2, {
          delta,
          base: { ...base, size: MAX_DICTIONARY_BYTES + 1 },
        }),
      ),
    ).toBeNull();
    expect(await p(nativeReq(v2, { delta, base: null }))).toBeNull();
    expect(urls).toEqual([]);
    // At exactly 100 MiB it is asked.
    await p(
      nativeReq(v2, { delta, base: { ...base, size: MAX_DICTIONARY_BYTES } }),
    );
    expect(urls).toHaveLength(1);
    const none = port(() => new Response(Buffer.from(PROBE_TARGET)), {
      template: () => null,
    });
    expect(await none.p(nativeReq(v2))).toBeNull();
    expect(none.urls).toEqual([]);
  });

  it("declines on anything but a 200 (406, 409, 404), writing nothing", async () => {
    const v1 = await release({ version: "1.0.0", seq: 1, payload: PROBE_BASE });
    for (const status of [406, 409, 404, 401]) {
      const written: Uint8Array[] = [];
      const { p, events } = port(() => new Response(null, { status }));
      expect(await p(nativeReq(v1, { written }))).toBeNull();
      expect(written).toEqual([]);
      expect(events).toEqual([
        {
          packId: PACK,
          kind: "zstd",
          via: "page",
          outcome: "declined",
          status,
        },
      ]);
    }
  });

  it("fails a body longer than the payload, and a transfer that breaks", async () => {
    const v1 = await release({ version: "1.0.0", seq: 1, payload: PROBE_BASE });
    const long = port(
      () => new Response(Buffer.alloc(PROBE_BASE.byteLength + 1)),
    );
    expect(await long.p(nativeReq(v1))).toEqual({
      ok: false,
      error: "too-large",
    });
    const broken = port(() => {
      throw new TypeError("Failed to fetch");
    });
    expect(await broken.p(nativeReq(v1))).toEqual({
      ok: false,
      error: "network-error",
    });
    const midway = port(
      () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(PROBE_BASE.subarray(0, 10));
              c.error(new TypeError("dcz decode failed"));
            },
          }),
        ),
    );
    expect(await midway.p(nativeReq(v1))).toEqual({
      ok: false,
      error: "network-error",
    });
  });

  it("hands the transfer to the OPFS worker's fetchInto when the store has one", async () => {
    const v1 = await release({ version: "1.0.0", seq: 1, payload: PROBE_BASE });
    const seen: unknown[] = [];
    const { p, urls } = port(() => new Response(Buffer.from(PROBE_BASE)), {
      fetchIntoOutput: async (planId, url, init, limit) => {
        seen.push({ planId, url, init, limit });
        return {
          status: 200,
          size: PROBE_BASE.byteLength,
          sha256: sha(PROBE_BASE),
        };
      },
    });
    expect(await p(nativeReq(v1))).toEqual({
      ok: true,
      size: PROBE_BASE.byteLength,
      sha256: sha(PROBE_BASE),
    });
    expect(urls).toEqual([]);
    expect(seen).toEqual([
      {
        planId: "plan-1",
        url: `${BYTES}/${PRODUCT}/distribution/packs/${PACK}/default/payload/${sha(PROBE_BASE)}`,
        init: { headers: {} },
        limit: PROBE_BASE.byteLength,
      },
    ]);
  });
});

// ── The chain through createBrowserPacks ─────────────────────────────────────────────────────

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
    distribution: { enabled: true, endpoints: { blobs: BLOBS } },
  },
};

/** A server over the releases: records, the blob route, and the payload URL with dcz decided by
 *  `dictionary` (the base the browser would offer, or null). Answers are DECODED, as `fetch`
 *  returns them. */
function server(
  releases: Release[],
  dictionary: { base: string | null },
  /** plans/P4-29.md §6.3: target payload → the base of a lazy delta the Worker holds. */
  lazy: Record<string, string> = {},
) {
  const records = new Map(releases.map((r) => [r.recordSha256, r.jws]));
  const objects = new Map<string, Uint8Array>();
  for (const r of releases) for (const [h, b] of r.objects) objects.set(h, b);
  const payloads = new Map(releases.map((r) => [sha(r.payload), r]));
  const log: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const rec = /\/release\/records\/([0-9a-f]{64})$/.exec(url.pathname);
    if (rec) {
      log.push(`record`);
      const body = records.get(rec[1]!);
      return new Response(body ?? "", { status: body ? 200 : 404 });
    }
    const blob = /\/distribution\/blobs\/sha256\/([0-9a-f]{64})$/.exec(
      url.pathname,
    );
    if (blob) {
      log.push(`blob ${blob[1]!.slice(0, 8)}`);
      const b = objects.get(blob[1]!);
      return new Response(b ? Buffer.from(b) : "", { status: b ? 200 : 404 });
    }
    const pay =
      /\/distribution\/packs\/[^/]+\/[^/]+\/payload\/([0-9a-f]{64})$/.exec(
        url.pathname,
      );
    if (pay) {
      const r = payloads.get(pay[1]!)!;
      const guard = url.searchParams.get("via") === "dcz";
      const from =
        (r.variant.deltas?.[0] as { from?: string } | undefined)?.from ??
        lazy[pay[1]!];
      if (guard && (dictionary.base === null || dictionary.base !== from)) {
        log.push(`payload ${pay[1]!.slice(0, 8)} 409`);
        return new Response(null, { status: 409 });
      }
      log.push(`payload ${pay[1]!.slice(0, 8)} ${guard ? "dcz" : "zstd"}`);
      return new Response(Buffer.from(r.payload));
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { impl, log };
}

function browserPacks(
  srv: ReturnType<typeof server>,
  first: Release,
  extra: Record<string, unknown> = {},
) {
  const events: PackProgress[] = [];
  const native: NativePayloadEvent[] = [];
  const p = createBrowserPacks({
    baseUrl: BASE,
    product: PRODUCT,
    discovery: discovery as never,
    releaseKeys: RELEASE_KEYS,
    productTrust: PRODUCT_TRUST,
    contentStamp: {
      contentApi: 1,
      pins: [
        {
          pack: PACK,
          release: {
            sha256: first.recordSha256,
            seq: first.seq,
            version: first.version,
          },
        },
      ],
      expects: [{ pack: PACK, required: true, delivery: "essential" }],
    } as never,
    fetchImpl: srv.impl,
    zstd,
    storage: "memory",
    handlers: [BLOB],
    onNativePayload: (e) => native.push(e),
    ...extra,
  });
  p.on((e) => events.push(e));
  return { p, events, native };
}

const target = (r: Release) => ({
  pack: PACK,
  release: { sha256: r.recordSha256, seq: r.seq, version: r.version },
});

describe("createBrowserPacks over the payload URL (P4-18)", () => {
  async function chain() {
    const v1 = await release({ version: "1.0.0", seq: 1, payload: PROBE_BASE });
    const v2 = await release({
      version: "1.1.0",
      seq: 2,
      payload: PROBE_TARGET,
      delta: { from: PROBE_BASE, frame: PROBE_FRAME },
    });
    return { v1, v2 };
  }

  it("installs v1 over the payload URL and updates to v2 over dcz: no blob is fetched", async () => {
    const { v1, v2 } = await chain();
    const srv = server([v1, v2], { base: sha(PROBE_BASE) });
    const { p, events, native } = browserPacks(srv, v1);
    await p.ensure([PACK]);
    const [i] = await p.ensureReleases([target(v2)]);
    expect(i!.payloadSha256).toBe(sha(PROBE_TARGET));
    expect(srv.log.filter((l) => !l.startsWith("record"))).toEqual([
      `payload ${sha(PROBE_BASE).slice(0, 8)} zstd`,
      `payload ${sha(PROBE_TARGET).slice(0, 8)} dcz`,
    ]);
    expect(native.map((e) => `${e.kind} ${e.outcome}`)).toEqual([
      "zstd used",
      "dcz used",
    ]);
    expect(events.some((e) => e.phase === "fallback")).toBe(false);
  });

  it("takes the WASM delta over the blob route when the dictionary is gone (409), reporting nothing as failed", async () => {
    const { v1, v2 } = await chain();
    const srv = server([v1, v2], { base: null });
    const { p, events, native } = browserPacks(srv, v1);
    await p.ensure([PACK]);
    const [i] = await p.ensureReleases([target(v2)]);
    expect(i!.payloadSha256).toBe(sha(PROBE_TARGET));
    expect(srv.log.filter((l) => !l.startsWith("record"))).toEqual([
      `payload ${sha(PROBE_BASE).slice(0, 8)} zstd`,
      `payload ${sha(PROBE_TARGET).slice(0, 8)} 409`,
      `blob ${sha(PROBE_FRAME).slice(0, 8)}`,
    ]);
    expect(native.map((e) => `${e.kind} ${e.outcome} ${e.status}`)).toEqual([
      "zstd used 200",
      "dcz declined 409",
    ]);
    expect(events.some((e) => e.phase === "fallback")).toBe(false);
  });

  it("never touches the payload URL with nativePayload: false", async () => {
    const { v1, v2 } = await chain();
    const srv = server([v1, v2], { base: sha(PROBE_BASE) });
    const { p } = browserPacks(srv, v1, { nativePayload: false });
    await p.ensure([PACK]);
    await p.ensureReleases([target(v2)]);
    expect(srv.log.some((l) => l.startsWith("payload"))).toBe(false);
  });
});

// ── The worker client ────────────────────────────────────────────────────────────────────────

/** A fake worker answering the protocol from memory, as `opfsWorker.ts` would. */
function fakeWorker(o: { failInit?: boolean; silent?: boolean } = {}) {
  const files = new Map<string, Uint8Array>();
  const listeners: ((e: MessageEvent) => void)[] = [];
  const posted: { op: string; transfer: number }[] = [];
  const reply = (data: unknown) =>
    queueMicrotask(() => listeners.forEach((l) => l({ data } as MessageEvent)));
  const w: WorkerLike & { terminated: boolean } = {
    terminated: false,
    addEventListener(type, l) {
      if (type === "message") listeners.push(l as (e: MessageEvent) => void);
    },
    terminate() {
      w.terminated = true;
    },
    postMessage(m: unknown, transfer?: Transferable[]) {
      const req = m as { id: number; op: string } & Record<string, never>;
      posted.push({ op: req.op, transfer: transfer?.length ?? 0 });
      if (o.silent) return;
      const key = (p: string[]) => p.join("/");
      switch (req.op) {
        case "init":
          return reply(
            o.failInit
              ? {
                  id: req.id,
                  ok: false,
                  error: "no OPFS",
                  name: "SecurityError",
                }
              : { id: req.id, ok: true, value: true },
          );
        case "writeAt": {
          const k = key(req.path as unknown as string[]);
          const cur = files.get(k) ?? new Uint8Array();
          const b = req.bytes as unknown as Uint8Array;
          const at = req.offset as unknown as number;
          const out = new Uint8Array(Math.max(cur.length, at + b.length));
          out.set(cur);
          out.set(b, at);
          files.set(k, out);
          return reply({ id: req.id, ok: true, value: null });
        }
        case "read": {
          const b = files.get(key(req.path as unknown as string[]));
          const at = req.offset as unknown as number;
          const n = req.length as unknown as number;
          return reply({
            id: req.id,
            ok: true,
            value: b ? b.slice(at, at + n) : new Uint8Array(),
          });
        }
        case "size": {
          const b = files.get(key(req.path as unknown as string[]));
          return reply({ id: req.id, ok: true, value: b ? b.length : null });
        }
        case "fetchInto":
          reply({ id: req.id, progress: 5 });
          return reply({
            id: req.id,
            ok: true,
            value: { status: 200, size: 5, sha256: sha("hello") },
          });
        default:
          return reply({
            id: req.id,
            ok: false,
            error: "nope",
            name: "NotFoundError",
          });
      }
    },
  };
  return { w, files, posted };
}

describe("the OPFS worker client (P4-18)", () => {
  it("initialises, writes with a transferred copy, reads back, and reports a worker's DOMException name", async () => {
    const f = fakeWorker();
    const io = await workerIo(f.w, ["polaris-key", PRODUCT, "packs"]);
    expect(io.kind).toBe("worker");
    const bytes = enc("hello world");
    await io.writeAt(["staging", "p", "out", "payload.bin"], 0, bytes);
    // The caller's buffer is untouched (the worker got a transferred copy).
    expect(new TextDecoder().decode(bytes)).toBe("hello world");
    expect(f.posted.find((x) => x.op === "writeAt")!.transfer).toBe(1);
    expect(
      new TextDecoder().decode(
        await io.read(["staging", "p", "out", "payload.bin"], 6, 5),
      ),
    ).toBe("world");
    expect(await io.size(["staging", "p", "out", "payload.bin"])).toBe(11);
    expect(await io.size(["nothing"])).toBeNull();
    await expect(io.hash(["nothing"])).rejects.toMatchObject({
      name: "NotFoundError",
    });
    const progress: number[] = [];
    expect(
      await io.fetchInto!(["x"], "https://dl/x", { headers: {} }, 10, (n) =>
        progress.push(n),
      ),
    ).toEqual({ status: 200, size: 5, sha256: sha("hello") });
    expect(progress).toEqual([5]);
    io.close();
    expect(f.w.terminated).toBe(true);
    await expect(io.size(["x"])).rejects.toThrow(/closed/);
  });

  it("refuses a worker that cannot reach OPFS, or does not answer, and stops it", async () => {
    const bad = fakeWorker({ failInit: true });
    await expect(workerIo(bad.w, ["r"])).rejects.toMatchObject({
      name: "SecurityError",
    });
    expect(bad.w.terminated).toBe(true);
    const silent = fakeWorker({ silent: true });
    await expect(workerIo(silent.w, ["r"], 20)).rejects.toThrow(
      /did not start/,
    );
    expect(silent.w.terminated).toBe(true);
  });
});

// @pkey-feature packs.delta.feed
describe("createBrowserPacks and the feed's delta menu (plans/P4-29.md §2.4, §6.3)", () => {
  async function chain() {
    const v1 = await release({ version: "1.0.0", seq: 1, payload: PROBE_BASE });
    // v2's record carries no delta; the feed offers the lazy one, whose frame the blob route
    // holds and whose base the payload URL answers dcz from.
    const v2 = await release({
      version: "1.1.0",
      seq: 2,
      payload: PROBE_TARGET,
    });
    v2.objects.set(sha(PROBE_FRAME), PROBE_FRAME);
    const menu = {
      [sha(PROBE_TARGET)]: [
        {
          from: sha(PROBE_BASE),
          method: "zstd-patch-from",
          scope: "payload" as const,
          memBytes: PROBE_BASE.byteLength + PROBE_TARGET.byteLength,
          artifact: { sha256: sha(PROBE_FRAME), bytes: PROBE_FRAME.byteLength },
        },
      ],
    };
    return { v1, v2, menu };
  }

  it("takes a lazy delta over dcz on the payload URL once a decision recorded the menu", async () => {
    const { v1, v2, menu } = await chain();
    const srv = server(
      [v1, v2],
      { base: sha(PROBE_BASE) },
      {
        [sha(PROBE_TARGET)]: sha(PROBE_BASE),
      },
    );
    const { p, events, native } = browserPacks(srv, v1);
    await p.ensure([PACK]);
    p.recordFeedDeltas(menu);
    const [i] = await p.ensureReleases([target(v2)]);
    expect(i!.payloadSha256).toBe(sha(PROBE_TARGET));
    expect(srv.log.filter((l) => !l.startsWith("record"))).toEqual([
      `payload ${sha(PROBE_BASE).slice(0, 8)} zstd`,
      `payload ${sha(PROBE_TARGET).slice(0, 8)} dcz`,
    ]);
    expect(native.map((e) => `${e.kind} ${e.outcome}`)).toEqual([
      "zstd used",
      "dcz used",
    ]);
    expect(events.some((e) => e.phase === "fallback")).toBe(false);
  });

  it("without the dictionary (409), runs the lazy delta's frame from the blob route in WASM", async () => {
    const { v1, v2, menu } = await chain();
    const srv = server([v1, v2], { base: null });
    const { p } = browserPacks(srv, v1, { feedDeltas: () => menu });
    await p.ensure([PACK]);
    const [i] = await p.ensureReleases([target(v2)]);
    expect(i!.payloadSha256).toBe(sha(PROBE_TARGET));
    expect(srv.log.filter((l) => !l.startsWith("record"))).toEqual([
      `payload ${sha(PROBE_BASE).slice(0, 8)} zstd`,
      `payload ${sha(PROBE_TARGET).slice(0, 8)} 409`,
      `blob ${sha(PROBE_FRAME).slice(0, 8)}`,
    ]);
  });

  it("with no menu, installs v2 whole: the record offers no delta", async () => {
    const { v1, v2 } = await chain();
    const srv = server([v1, v2], { base: sha(PROBE_BASE) });
    const { p } = browserPacks(srv, v1);
    await p.ensure([PACK]);
    await p.ensureReleases([target(v2)]);
    expect(srv.log.filter((l) => !l.startsWith("record"))).toEqual([
      `payload ${sha(PROBE_BASE).slice(0, 8)} zstd`,
      `payload ${sha(PROBE_TARGET).slice(0, 8)} zstd`,
    ]);
  });
});
