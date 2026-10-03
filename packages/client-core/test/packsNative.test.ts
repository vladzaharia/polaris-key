// The host's native payload transport in the pack engine (P4-18): how a container's `full` and a
// planned `zstd-patch-from` payload delta execute on a platform that decodes them itself (the
// browser's zstd and Compression Dictionary Transport). The plan is unchanged; the transport is
// tried first; its output is checked against the record; a decline runs the candidate in the
// engine, a failure is reported (`fallback`, `via: "native"`) and then does the same, and the
// plan's remaining candidates follow.
//
// @pkey-feature packs.apply.delta packs.apply.full

import { describe, expect, it } from "vitest";
import {
  decode as wasmDecode,
  decodeWithPrefix as wasmDecodeWithPrefix,
} from "@polaris-key/zstd-wasm";
import {
  PackEngine,
  memoryPackStateStore,
  memoryPackStorage,
  type NativePayloadPort,
  type NativePayloadRequest,
  type ObjectResponse,
  type PackEngineOptions,
  type PackHandler,
  type PackProgress,
  type ZstdPort,
} from "../src/index.js";
import {
  PRODUCT,
  PRODUCT_TRUST,
  PROBE_BASE,
  PROBE_FRAME,
  PROBE_TARGET,
  RELEASE_KEYS,
  sha,
  signReleaseDoc,
} from "./packFixtures.js";

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

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const PACK = "djdl.levels";

interface Release {
  version: string;
  seq: number;
  jws: string;
  recordSha256: string;
  payload: Uint8Array;
  objects: Map<string, Uint8Array>;
}

/** A container release over `payload` (one file), `full` stored raw; `delta` adds a payload
 *  delta from `from` whose artifact is `frame`. */
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
  const jws = await signReleaseDoc({
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
    variants: [
      {
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
                  scope: "payload",
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
      },
    ],
  });
  return {
    version: o.version,
    seq: o.seq,
    jws,
    recordSha256: sha(jws),
    payload,
    objects,
  };
}

/** A blob server over the releases; `corrupt` answers that object with one byte flipped. */
function server(...releases: Release[]) {
  const records = new Map(releases.map((r) => [r.recordSha256, r.jws]));
  const objects = new Map<string, Uint8Array>();
  for (const r of releases) for (const [h, b] of r.objects) objects.set(h, b);
  const s = {
    fetched: [] as string[],
    corrupt: new Set<string>(),
    fetchRecord: async (h: string) => {
      const body = records.get(h);
      return body === undefined
        ? ({ ok: false, code: "not_found" } as const)
        : ({ ok: true, body } as const);
    },
    fetchObject: async (req: { sha256: string }): Promise<ObjectResponse> => {
      s.fetched.push(req.sha256);
      let b = objects.get(req.sha256);
      if (b && s.corrupt.has(req.sha256)) {
        b = b.slice();
        b[0] = b[0]! ^ 0xff;
      }
      return b
        ? {
            status: 200,
            contentRange: null,
            chunks: (async function* () {
              yield b;
            })(),
          }
        : {
            status: 404,
            contentRange: null,
            chunks: (async function* () {})(),
          };
    },
  };
  return s;
}

let plans = 0;
const stampOf = (r: Release) => ({
  contentApi: 1,
  pins: [
    {
      pack: PACK,
      release: { sha256: r.recordSha256, seq: r.seq, version: r.version },
    },
  ],
  expects: [{ pack: PACK, required: true, delivery: "essential" }],
});

function engine(
  srv: ReturnType<typeof server>,
  first: Release,
  o: Partial<PackEngineOptions> = {},
): { e: PackEngine; events: PackProgress[] } {
  const e = new PackEngine({
    product: PRODUCT,
    releaseKeys: RELEASE_KEYS,
    productTrust: () => PRODUCT_TRUST,
    stamp: stampOf(first),
    prefs: { engine: null, axes: {} },
    zstd,
    sha256: () => {
      const parts: Uint8Array[] = [];
      return {
        update: (b) => void parts.push(b.slice()),
        digest: () => sha(Buffer.concat(parts)),
      };
    },
    patchMethods: ["zstd-patch-from"],
    memBudget: 1 << 30,
    storage: memoryPackStorage(),
    state: memoryPackStateStore(),
    fetchRecord: (h) => srv.fetchRecord(h),
    fetchObject: (r) => srv.fetchObject(r),
    now: () => 1759400000,
    newPlanId: () => `native-plan-${++plans}`,
    handlers: [BLOB],
    ...o,
  });
  const events: PackProgress[] = [];
  e.on((p) => events.push(p));
  return { e, events };
}

const target = (r: Release) => ({
  pack: PACK,
  release: { sha256: r.recordSha256, seq: r.seq, version: r.version },
});

/** A native transport that "decodes" from a table of payloads by hash, recording requests. */
function nativeFrom(
  payloads: Uint8Array[],
  o: { decline?: (r: NativePayloadRequest) => boolean; wrong?: boolean } = {},
) {
  const calls: NativePayloadRequest[] = [];
  const port: NativePayloadPort = async (req) => {
    calls.push(req);
    if (o.decline?.(req)) return null;
    let bytes = payloads.find((p) => sha(p) === req.variant.payload.sha256);
    if (!bytes) return { ok: false, error: "unknown" };
    if (o.wrong) bytes = enc("not the payload at all");
    await req.sink.write(0, bytes);
    req.onBytes(bytes.byteLength);
    return { ok: true, size: bytes.byteLength, sha256: sha(bytes) };
  };
  return { port, calls };
}

/** One zstd frame of raw blocks (RFC 8878 §3.1.1.2), with its content size. */
function rawFrame(content: Uint8Array): Uint8Array {
  const n = content.length;
  const h = (n << 3) | 1;
  return Uint8Array.from([
    0x28,
    0xb5,
    0x2f,
    0xfd,
    0xa0,
    n & 0xff,
    (n >>> 8) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 24) & 0xff,
    h & 0xff,
    (h >>> 8) & 0xff,
    (h >>> 16) & 0xff,
    ...content,
  ]);
}

async function v1v2() {
  const v1 = await release({ version: "1.0.0", seq: 1, payload: PROBE_BASE });
  const v2 = await release({
    version: "1.1.0",
    seq: 2,
    payload: PROBE_TARGET,
    delta: { from: PROBE_BASE, frame: PROBE_FRAME },
  });
  return { v1, v2 };
}

async function payloadOf(e: PackEngine): Promise<string | undefined> {
  return e.state().active[PACK]?.payloadSha256;
}

describe("the native payload transport (P4-18)", () => {
  it("runs a container's full and then its payload delta natively: no object is fetched", async () => {
    const { v1, v2 } = await v1v2();
    const srv = server(v1, v2);
    const native = nativeFrom([PROBE_BASE, PROBE_TARGET]);
    const { e, events } = engine(srv, v1, { nativePayload: native.port });
    await e.load();
    await e.ensureReleases([target(v1)]);
    expect(await payloadOf(e)).toBe(sha(PROBE_BASE));
    await e.ensureReleases([target(v2)]);
    expect(await payloadOf(e)).toBe(sha(PROBE_TARGET));
    expect(srv.fetched).toEqual([]);

    expect(native.calls.map((c) => (c.delta ? "delta" : "full"))).toEqual([
      "full",
      "delta",
    ]);
    const d = native.calls[1]!;
    expect(d.delta!.from).toBe(sha(PROBE_BASE));
    expect(d.delta!.artifact.sha256).toBe(sha(PROBE_FRAME));
    expect(d.base).toEqual({
      sha256: sha(PROBE_BASE),
      size: PROBE_BASE.byteLength,
    });
    expect(d.gated).toBe(false);
    expect(events.some((p) => p.phase === "fallback")).toBe(false);
    expect(events.filter((p) => p.phase === "done")).toHaveLength(2);
  });

  it("runs the candidate itself when the transport declines, with nothing reported", async () => {
    const { v1, v2 } = await v1v2();
    const srv = server(v1, v2);
    const native = nativeFrom([PROBE_BASE, PROBE_TARGET], {
      decline: (r) => r.delta !== null,
    });
    const { e, events } = engine(srv, v1, { nativePayload: native.port });
    await e.load();
    await e.ensureReleases([target(v1)]);
    await e.ensureReleases([target(v2)]);
    expect(await payloadOf(e)).toBe(sha(PROBE_TARGET));
    // The WASM delta: the artifact from the blob route, and nothing else.
    expect(srv.fetched).toEqual([sha(PROBE_FRAME)]);
    expect(events.some((p) => p.phase === "fallback")).toBe(false);
  });

  it("checks the transport's output against the record: a mismatch is reported and the WASM delta runs from an empty output", async () => {
    const { v1, v2 } = await v1v2();
    const srv = server(v1, v2);
    const good = nativeFrom([PROBE_BASE, PROBE_TARGET]);
    const bad = nativeFrom([PROBE_BASE, PROBE_TARGET], { wrong: true });
    const port: NativePayloadPort = (r) =>
      r.delta ? bad.port(r) : good.port(r);
    const { e, events } = engine(srv, v1, { nativePayload: port });
    await e.load();
    await e.ensureReleases([target(v1)]);
    await e.ensureReleases([target(v2)]);
    expect(await payloadOf(e)).toBe(sha(PROBE_TARGET));
    expect(srv.fetched).toEqual([sha(PROBE_FRAME)]);
    expect(events.filter((p) => p.phase === "fallback")).toEqual([
      expect.objectContaining({
        packId: PACK,
        strategy: "delta",
        via: "native",
        error: "delta-apply-failed",
      }),
    ]);
  });

  it("reports a transport that throws as a network error, then runs the candidate", async () => {
    const { v1, v2 } = await v1v2();
    const srv = server(v1, v2);
    const good = nativeFrom([PROBE_BASE, PROBE_TARGET]);
    const port: NativePayloadPort = async (r) => {
      if (r.delta) throw new Error("dictionary decode failed");
      return good.port(r);
    };
    const { e, events } = engine(srv, v1, { nativePayload: port });
    await e.load();
    await e.ensureReleases([target(v1)]);
    await e.ensureReleases([target(v2)]);
    expect(await payloadOf(e)).toBe(sha(PROBE_TARGET));
    expect(events.filter((p) => p.phase === "fallback")).toEqual([
      expect.objectContaining({ via: "native", error: "network-error" }),
    ]);
  });

  it("with a corrupt artifact, falls back to the WASM delta, which refuses it: the failure is reported and nothing changes", async () => {
    const { v1, v2 } = await v1v2();
    const srv = server(v1, v2);
    srv.corrupt.add(sha(PROBE_FRAME));
    // The browser's decode of the corrupt dcz body fails; the blob route's copy is corrupt too.
    const good = nativeFrom([PROBE_BASE, PROBE_TARGET]);
    const port: NativePayloadPort = async (r) =>
      r.delta ? { ok: false, error: "network-error" } : good.port(r);
    const { e, events } = engine(srv, v1, { nativePayload: port });
    await e.load();
    await e.ensureReleases([target(v1)]);
    // P4-06's rule: an object whose bytes miss its hash is never applied; the attempt ends with
    // `network-error` and the next ensure retries it.
    await expect(e.ensureReleases([target(v2)])).rejects.toMatchObject({
      code: "network-error",
    });
    expect(await payloadOf(e)).toBe(sha(PROBE_BASE));
    expect(events.filter((p) => p.phase === "fallback")).toEqual([
      expect.objectContaining({ strategy: "delta", via: "native" }),
    ]);
    expect(
      srv.fetched.filter((h) => h === sha(PROBE_FRAME)).length,
    ).toBeGreaterThan(0);
    // Repaired at the source: the next ensure installs v2.
    srv.corrupt.clear();
    await e.ensureReleases([target(v2)]);
    expect(await payloadOf(e)).toBe(sha(PROBE_TARGET));
  });

  it("falls to the plan's next candidate when the delta itself does not apply, reporting each failure", async () => {
    // A well-formed artifact (its hash is the record's) whose frame does not rebuild v2.
    const bogus = rawFrame(enc("this frame ignores its base entirely\n"));
    const v1 = await release({ version: "1.0.0", seq: 1, payload: PROBE_BASE });
    const v2 = await release({
      version: "1.1.0",
      seq: 2,
      payload: PROBE_TARGET,
      delta: { from: PROBE_BASE, frame: bogus },
    });
    const srv = server(v1, v2);
    const good = nativeFrom([PROBE_BASE, PROBE_TARGET]);
    const port: NativePayloadPort = async (r) =>
      r.delta ? { ok: false, error: "network-error" } : good.port(r);
    const { e, events } = engine(srv, v1, { nativePayload: port });
    await e.load();
    await e.ensureReleases([target(v1)]);
    await e.ensureReleases([target(v2)]);
    expect(await payloadOf(e)).toBe(sha(PROBE_TARGET));
    const fallbacks = events.filter((p) => p.phase === "fallback");
    expect(fallbacks).toEqual([
      expect.objectContaining({ strategy: "delta", via: "native" }),
      expect.objectContaining({
        strategy: "delta",
        error: "delta-apply-failed",
      }),
    ]);
    expect(fallbacks[1]!.via).toBeUndefined();
    // The next candidate (the whole payload) went through the transport too, and succeeded.
    expect(good.calls.map((c) => (c.delta ? "delta" : "full"))).toEqual([
      "full",
      "full",
    ]);
  });

  it("tells the transport a pack is gated", async () => {
    const v1 = await release({
      version: "1.0.0",
      seq: 1,
      payload: PROBE_BASE,
      entitlement: "vault",
    });
    const native = nativeFrom([PROBE_BASE]);
    const { e } = engine(server(v1), v1, { nativePayload: native.port });
    await e.load();
    await e.ensureReleases([target(v1)]);
    expect(native.calls[0]!.gated).toBe(true);
  });

  it("is never asked for a tree", async () => {
    const native = nativeFrom([]);
    const { treePack, byteServer } = await import("./packFixtures.js");
    const t = await treePack({
      packId: "djdl.skins",
      version: "1.0.0",
      seq: 1,
      files: { "a.txt": "a" },
    });
    const srv = byteServer(t);
    const e = new PackEngine({
      product: PRODUCT,
      releaseKeys: RELEASE_KEYS,
      productTrust: () => PRODUCT_TRUST,
      stamp: {
        contentApi: 1,
        pins: [
          {
            pack: t.packId,
            release: { sha256: t.recordSha256, seq: t.seq, version: t.version },
          },
        ],
        expects: [{ pack: t.packId, required: true, delivery: "essential" }],
      },
      prefs: { engine: null, axes: {} },
      zstd,
      sha256: () => {
        const parts: Uint8Array[] = [];
        return {
          update: (b) => void parts.push(b.slice()),
          digest: () => sha(Buffer.concat(parts)),
        };
      },
      patchMethods: ["zstd-patch-from"],
      memBudget: 1 << 30,
      storage: memoryPackStorage(),
      state: memoryPackStateStore(),
      fetchRecord: (h) => srv.fetchRecord(h),
      fetchObject: (r) => srv.fetchObject(r),
      now: () => 1759400000,
      newPlanId: () => `native-plan-${++plans}`,
      nativePayload: native.port,
    });
    await e.load();
    await e.ensureReleases([
      {
        pack: t.packId,
        release: { sha256: t.recordSha256, seq: t.seq, version: t.version },
      },
    ]);
    expect(native.calls).toEqual([]);
  });
});
