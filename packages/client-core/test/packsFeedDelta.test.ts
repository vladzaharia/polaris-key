// The feed's delta menu in the pack engine (plans/P4-29.md §2.4): a lazy delta the committed feed
// offers joins the record's deltas as one more candidate, is checked like any delta (artifact,
// base, output against the CI-signed record), falls back on any failure, and at most one
// feed-offered delta is tried per install. A journal keeps the entry, so a resume plans it again.
//
// @pkey-feature packs.delta.feed

import { describe, expect, it } from "vitest";
import {
  decode as wasmDecode,
  decodeWithPrefix as wasmDecodeWithPrefix,
} from "@polaris-key/zstd-wasm";
import type { FeedDelta, FeedDeltas } from "@polaris-key/protocol/update";
import {
  PackEngine,
  memoryPackStateStore,
  memoryPackStorage,
  memorySource,
  parsePackState,
  serializePackState,
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
    newPlanId: () => `feed-plan-${++plans}`,
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

/** A feed menu entry to `PROBE_TARGET` from `base`, whose artifact is `frame`. */
const entry = (base: Uint8Array, frame: Uint8Array): FeedDelta => ({
  from: sha(base),
  method: "zstd-patch-from",
  scope: "payload",
  memBytes: base.byteLength + PROBE_TARGET.byteLength,
  artifact: { sha256: sha(frame), bytes: frame.byteLength },
});
const menuOf = (...entries: FeedDelta[]): FeedDeltas => ({
  [sha(PROBE_TARGET)]: entries,
});

/** v1 (`PROBE_BASE`) and v2 (`PROBE_TARGET`) with NO record delta; `extra` objects are on the
 *  server beside them (feed-offered frames). */
async function pair(...extra: Uint8Array[]) {
  const v1 = await release({ version: "1.0.0", seq: 1, payload: PROBE_BASE });
  const v2 = await release({ version: "1.1.0", seq: 2, payload: PROBE_TARGET });
  for (const b of extra) v2.objects.set(sha(b), b);
  return { v1, v2 };
}

const fallbacks = (events: PackProgress[]) =>
  events.filter((p) => p.phase === "fallback");

describe("feed-offered deltas in the pack engine (plans/P4-29.md §2.4)", () => {
  it("plans the feed's delta for a record that carries none, and installs it", async () => {
    const { v1, v2 } = await pair(PROBE_FRAME);
    const srv = server(v1, v2);
    const { e, events } = engine(srv, v1, {
      feedDeltas: () => menuOf(entry(PROBE_BASE, PROBE_FRAME)),
    });
    await e.load();
    await e.ensureReleases([target(v1)]);
    srv.fetched.length = 0;
    await e.ensureReleases([target(v2)]);
    expect(await payloadOf(e)).toBe(sha(PROBE_TARGET));
    expect(srv.fetched).toEqual([sha(PROBE_FRAME)]);
    expect(fallbacks(events)).toEqual([]);
    // P4-17: a feed-delta install is reported as `delta`, which keeps the pair warm.
    expect(e.packInstalls().at(-1)).toMatchObject({
      from: sha(PROBE_BASE),
      to: sha(PROBE_TARGET),
      strategy: "delta",
      fallbackUsed: false,
    });
  });

  it("falls back when the feed's delta 404s (a cold delta), and installs by the next candidate", async () => {
    const { v1, v2 } = await pair();
    const srv = server(v1, v2);
    const { e, events } = engine(srv, v1, {
      feedDeltas: () => menuOf(entry(PROBE_BASE, PROBE_FRAME)),
    });
    await e.load();
    await e.ensureReleases([target(v1)]);
    await e.ensureReleases([target(v2)]);
    expect(await payloadOf(e)).toBe(sha(PROBE_TARGET));
    expect(fallbacks(events)).toEqual([
      expect.objectContaining({ strategy: "delta", error: "network-error" }),
    ]);
    expect(e.packInstalls().at(-1)).toMatchObject({
      fallbackUsed: true,
      failureStage: "network-error",
    });
  });

  it("falls back when the stored artifact does not match the menu entry", async () => {
    const { v1, v2 } = await pair(PROBE_FRAME);
    const srv = server(v1, v2);
    srv.corrupt.add(sha(PROBE_FRAME));
    const { e, events } = engine(srv, v1, {
      feedDeltas: () => menuOf(entry(PROBE_BASE, PROBE_FRAME)),
    });
    await e.load();
    await e.ensureReleases([target(v1)]);
    await e.ensureReleases([target(v2)]);
    expect(await payloadOf(e)).toBe(sha(PROBE_TARGET));
    expect(fallbacks(events)).toHaveLength(1);
    expect(fallbacks(events)[0]).toMatchObject({ strategy: "delta" });
  });

  it("checks the output against the RECORD: a frame that decodes to other bytes is refused (delta-apply-failed) and falls back", async () => {
    const other = new TextEncoder().encode(
      "not the payload the record pins, but a valid frame all the same\n",
    );
    const frame = rawFrame(other);
    const { v1, v2 } = await pair(frame);
    const srv = server(v1, v2);
    const { e, events } = engine(srv, v1, {
      feedDeltas: () =>
        menuOf({
          ...entry(PROBE_BASE, frame),
          memBytes: PROBE_BASE.byteLength + 4096,
        }),
    });
    await e.load();
    await e.ensureReleases([target(v1)]);
    await e.ensureReleases([target(v2)]);
    expect(await payloadOf(e)).toBe(sha(PROBE_TARGET));
    expect(fallbacks(events)).toEqual([
      expect.objectContaining({
        strategy: "delta",
        error: "delta-apply-failed",
      }),
    ]);
  });

  it("checks the base against `from`: an entry naming an installed payload whose bytes differ is refused (delta-base-mismatch) and falls back", async () => {
    const { v1, v2 } = await pair(PROBE_FRAME);
    const srv = server(v1, v2);
    const storage = memoryPackStorage();
    const { e, events } = engine(srv, v1, {
      storage,
      feedDeltas: () => menuOf(entry(PROBE_BASE, PROBE_FRAME)),
    });
    await e.load();
    await e.ensureReleases([target(v1)]);
    // The installed base's bytes change under the engine (a disk fault): its hash no longer
    // equals the entry's `from`.
    const real = storage.installed.bind(storage);
    storage.installed = async (i) => {
      const p = await real(i);
      if (!p?.payload) return p;
      const bytes = new Uint8Array(PROBE_BASE);
      bytes[0] = bytes[0]! ^ 1;
      return {
        ...p,
        payload: memorySource(bytes),
      };
    };
    await e.ensureReleases([target(v2)]);
    expect(await payloadOf(e)).toBe(sha(PROBE_TARGET));
    expect(fallbacks(events)).toEqual([
      expect.objectContaining({
        strategy: "delta",
        error: "delta-base-mismatch",
      }),
    ]);
  });

  it("tries at most one feed-offered delta per install: after it fails, the rest of the menu is skipped", async () => {
    // Two installed bases (A previous, PROBE_BASE active) and two feed entries: the cheap one
    // from PROBE_BASE 404s; the other, from A, is on the server but is never fetched.
    const a = new TextEncoder().encode("an older payload of the same pack\n");
    const second = rawFrame(PROBE_TARGET);
    const v0 = await release({ version: "0.9.0", seq: 1, payload: a });
    const v1 = await release({ version: "1.0.0", seq: 2, payload: PROBE_BASE });
    const v2 = await release({
      version: "1.1.0",
      seq: 3,
      payload: PROBE_TARGET,
    });
    v2.objects.set(sha(second), second);
    const srv = server(v0, v1, v2);
    const { e, events } = engine(srv, v0, {
      feedDeltas: () =>
        menuOf(entry(PROBE_BASE, PROBE_FRAME), entry(a, second)),
    });
    await e.load();
    await e.ensureReleases([target(v0)]);
    await e.ensureReleases([target(v1)]);
    srv.fetched.length = 0;
    await e.ensureReleases([target(v2)]);
    expect(await payloadOf(e)).toBe(sha(PROBE_TARGET));
    expect(srv.fetched).toContain(sha(PROBE_FRAME));
    expect(srv.fetched).not.toContain(sha(second));
    expect(fallbacks(events)).toHaveLength(1);
  });

  it("a record delta wins a cost tie, and a menu entry naming the record delta's id is not added twice", async () => {
    const v1 = await release({ version: "1.0.0", seq: 1, payload: PROBE_BASE });
    const v2 = await release({
      version: "1.1.0",
      seq: 2,
      payload: PROBE_TARGET,
      delta: { from: PROBE_BASE, frame: PROBE_FRAME },
    });
    const srv = server(v1, v2);
    const { e, events } = engine(srv, v1, {
      feedDeltas: () => menuOf(entry(PROBE_BASE, PROBE_FRAME)),
    });
    await e.load();
    await e.ensureReleases([target(v1)]);
    srv.fetched.length = 0;
    await e.ensureReleases([target(v2)]);
    expect(srv.fetched).toEqual([sha(PROBE_FRAME)]);
    expect(fallbacks(events)).toEqual([]);
  });

  it("reads the menu at each plan, and a source that throws is no menu", async () => {
    const { v1, v2 } = await pair(PROBE_FRAME);
    const srv = server(v1, v2);
    let calls = 0;
    const { e } = engine(srv, v1, {
      feedDeltas: () => {
        calls++;
        throw new Error("no committed feed");
      },
    });
    await e.load();
    await e.ensureReleases([target(v1)]);
    srv.fetched.length = 0;
    await e.ensureReleases([target(v2)]);
    expect(calls).toBeGreaterThan(0);
    expect(await payloadOf(e)).toBe(sha(PROBE_TARGET));
    expect(srv.fetched).not.toContain(sha(PROBE_FRAME));
  });

  it("a resumed journal plans its own feed delta again, even when the feed no longer lists it", async () => {
    const { v1, v2 } = await pair(PROBE_FRAME);
    const srv = server(v1, v2);
    const storage = memoryPackStorage();
    const state = memoryPackStateStore();
    const first = engine(srv, v1, { storage, state });
    await first.e.load();
    await first.e.ensureReleases([target(v1)]);
    // A crash after the journal of a feed-delta install was written.
    const doc = parsePackState(state.text);
    doc.inflight[PACK] = {
      planId: "resumed-plan",
      packId: PACK,
      record: v2.jws,
      recordSha256: v2.recordSha256,
      variant: "",
      strategy: "delta",
      delta: sha(PROBE_FRAME),
      feedDelta: entry(PROBE_BASE, PROBE_FRAME),
      objects: [
        { sha256: sha(PROBE_FRAME), bytes: PROBE_FRAME.byteLength, done: 0 },
      ],
      startedAt: 1759400000,
    };
    await state.replace(serializePackState(doc));
    const ids: string[] = [];
    const second = engine(srv, v1, {
      storage,
      state,
      feedDeltas: () => null,
      newPlanId: () => {
        ids.push("fresh");
        return "fresh-plan";
      },
    });
    await second.e.load();
    expect(second.e.state().inflight[PACK]?.planId).toBe("resumed-plan");
    srv.fetched.length = 0;
    await second.e.ensureReleases([target(v2)]);
    expect(await payloadOf(second.e)).toBe(sha(PROBE_TARGET));
    expect(srv.fetched).toEqual([sha(PROBE_FRAME)]);
    expect(ids).toEqual([]);
  });

  it("abandons a journal whose delta neither the record nor its feedDelta names, and plans afresh", async () => {
    const { v1, v2 } = await pair(PROBE_FRAME);
    const srv = server(v1, v2);
    const storage = memoryPackStorage();
    const state = memoryPackStateStore();
    const first = engine(srv, v1, { storage, state });
    await first.e.load();
    await first.e.ensureReleases([target(v1)]);
    const doc = parsePackState(state.text);
    doc.inflight[PACK] = {
      planId: "stale-plan",
      packId: PACK,
      record: v2.jws,
      recordSha256: v2.recordSha256,
      variant: "",
      strategy: "delta",
      delta: sha(PROBE_FRAME),
      objects: [
        { sha256: sha(PROBE_FRAME), bytes: PROBE_FRAME.byteLength, done: 0 },
      ],
      startedAt: 1759400000,
    };
    await state.replace(serializePackState(doc));
    const ids: string[] = [];
    const second = engine(srv, v1, {
      storage,
      state,
      newPlanId: () => {
        ids.push("fresh");
        return "fresh-plan";
      },
    });
    await second.e.load();
    await second.e.ensureReleases([target(v2)]);
    expect(await payloadOf(second.e)).toBe(sha(PROBE_TARGET));
    expect(ids.length).toBeGreaterThan(0);
    // No menu and no journalled entry: the frame is never planned.
    expect(srv.fetched).not.toContain(sha(PROBE_FRAME));
  });
});
