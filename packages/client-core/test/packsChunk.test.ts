// The chunk strategy in the pack engine (P4-11; plans/P4-10.md §2.5): seed indexes kept after an
// install, the fetch rule, single-range requests that equal the planner's runs, the fallback when
// a server ignores `Range`, resume from the run journal, cross-pack seeds and the exact
// `Content-Range` rule. The applier's verdicts are pinned by the content corpus
// (`applyCases`, `strategy: chunk`) in the conformance runners; these pin the I/O around it.
//
// @pkey-feature packs.apply.chunk packs.index.chunks

import { describe, expect, it } from "vitest";
import {
  decode as wasmDecode,
  decodeWithPrefix as wasmDecodeWithPrefix,
} from "@polaris-key/zstd-wasm";
import {
  PackEngine,
  chunkRangeFetch,
  memoryPackStateStore,
  memoryPackStorage,
  parseChunkIndexBytes,
  plan,
  planTarget,
  type MemoryPackStorage,
  type ObjectResponse,
  type PackEngineOptions,
  type PackHandler,
  type ZstdPort,
} from "../src/index.js";
import { PRODUCT, PRODUCT_TRUST, RELEASE_KEYS } from "./packFixtures.js";
import {
  chunkStamp,
  containerPack,
  rangeServer,
  sha,
  type ContainerPack,
} from "./chunkFixtures.js";
import type { PackVariant } from "@polaris-key/protocol/packs";
import { verifiedPayloadOf } from "../src/index.js";

const zstd: ZstdPort = {
  pointerBits: 30,
  decode: wasmDecode,
  decodeWithPrefix: wasmDecodeWithPrefix,
};

const BLOB: PackHandler = {
  type: "custom.blob",
  layout: "container",
  activation: "restart",
  supports: (v) => v === 1,
};

let plans = 0;
function engine(
  o: Partial<PackEngineOptions> & { server: ReturnType<typeof rangeServer> },
): PackEngine {
  const { server, ...rest } = o;
  return new PackEngine({
    product: PRODUCT,
    releaseKeys: RELEASE_KEYS,
    productTrust: () => PRODUCT_TRUST,
    stamp: null,
    prefs: { engine: null, axes: {} },
    zstd,
    sha256: () => {
      const parts: Uint8Array[] = [];
      return {
        update: (b) => void parts.push(b.slice()),
        digest: () => sha(Buffer.concat(parts)),
      };
    },
    patchMethods: [],
    memBudget: 1 << 30,
    storage: memoryPackStorage(),
    state: memoryPackStateStore(),
    fetchRecord: (h) => server.fetchRecord(h),
    fetchObject: (r) => server.fetchObject(r),
    now: () => 1759400000,
    newPlanId: () => `chunk-plan-${++plans}`,
    handlers: [BLOB],
    ...rest,
  });
}

const target = (p: ContainerPack) => ({
  pack: p.packId,
  release: { sha256: p.recordSha256, seq: p.seq, version: p.version },
});

/** v1 = a b c d e f (bundle B1); v2 = a g c h i f j, whose new bundle holds `g x h i y j`, so
 *  v2's runs from a v1 seed are [g], [h i], [j]. */
async function chain(packId = "djdl.levels") {
  const v1 = await containerPack({
    packId,
    version: "1.0.0",
    seq: 1,
    chunks: ["a", "b", "c", "d", "e", "f"],
    bundles: [["a", "b", "c", "d", "e", "f"]],
  });
  const v2 = await containerPack({
    packId,
    version: "1.1.0",
    seq: 2,
    chunks: ["a", "g", "c", "h", "i", "f", "j"],
    bundles: [
      ["a", "b", "c", "d", "e", "f"],
      ["g", null, "h", "i", null, "j"],
    ],
  });
  return { v1, v2 };
}

function variantOf(p: ContainerPack): PackVariant {
  return (verifiedPayloadOf(p.jws) as { variants: PackVariant[] }).variants[0]!;
}

/** The planner's chunk candidate for `to` over seeds `from` (the same inputs the engine builds). */
function plannedChunkRequests(to: ContainerPack, ...from: ContainerPack[]) {
  const idx = parseChunkIndexBytes(to.index, null);
  if (!idx.ok) throw new Error("index");
  const t = planTarget(variantOf(to), to.recordSha256, null, idx.index);
  const installed = from.map((f) => {
    const p = parseChunkIndexBytes(f.index, null);
    if (!p.ok) throw new Error("seed");
    return {
      release: f.recordSha256,
      payloadSha256: sha(f.payload),
      chunks: { ids: p.index.records.map((r) => r[0]) },
    };
  });
  const r = plan({
    target: t,
    installed,
    caps: {
      strategies: ["chunk"],
      patchMethods: [],
      transports: [],
      memBudget: 1 << 30,
      freeDisk: 1 << 30,
    },
  });
  if ("error" in r || r.strategy !== "chunk") throw new Error("no chunk plan");
  return r.requests;
}

async function installedBytes(
  storage: MemoryPackStorage,
  e: PackEngine,
  packId: string,
): Promise<Uint8Array> {
  const i = e.state().active[packId]!;
  return storage.store.get(i.location)!.payload!;
}

describe("PackEngine: chunk sync from seeds (P4-11)", () => {
  it("keeps v1's index as a seed after a full install, then installs v2 by chunk in the planner's runs", async () => {
    const { v1, v2 } = await chain();
    const server = rangeServer(v1, v2);
    const storage = memoryPackStorage();
    const e = engine({ server, storage, stamp: chunkStamp(v1) });
    await e.load();
    await e.ensure([v1.packId]);
    // First install: no seed, so `full`; afterwards v1's index is stored as a seed.
    expect(server.ranges()).toHaveLength(0);
    expect([...storage.indexes.keys()]).toEqual([v1.indexSha256]);

    server.calls.length = 0;
    const [install] = await e.ensureReleases([target(v2)]);
    expect(install!.payloadSha256).toBe(sha(v2.payload));
    expect(sha(await installedBytes(storage, e, v2.packId))).toBe(
      sha(v2.payload),
    );
    // One single-range request per run: [g], [h i], [j], with If-Range on the bundle hash.
    const ranges = server.ranges();
    expect(ranges).toHaveLength(3);
    expect(ranges).toHaveLength(plannedChunkRequests(v2, v1) - 1);
    for (const r of ranges) expect(r.ifRange).toBe(`"${r.sha256}"`);
    expect(ranges.map((r) => [r.offset, r.length])).toEqual([
      [0, 65536],
      [131072, 131072],
      [327680, 65536],
    ]);
    // The full payload was never fetched, and v2's index replaced v1's in the seed store once
    // v1 left the roots (v1 is `previous`, so both stay).
    expect(server.calls.some((c) => c.sha256 === sha(v2.payload))).toBe(false);
    expect([...storage.indexes.keys()].sort()).toEqual(
      [v1.indexSha256, v2.indexSha256].sort(),
    );
  });

  it("falls back to the next strategy when the server answers 200 to a range", async () => {
    const { v1, v2 } = await chain();
    const server = rangeServer(v1, v2);
    const storage = memoryPackStorage();
    const e = engine({ server, storage, stamp: chunkStamp(v1) });
    await e.load();
    await e.ensure([v1.packId]);
    server.ignoreRange = true;
    server.calls.length = 0;
    const [install] = await e.ensureReleases([target(v2)]);
    expect(install!.payloadSha256).toBe(sha(v2.payload));
    // One range was tried and refused; the body of the 200 was never used as chunk bytes.
    expect(server.ranges()).toHaveLength(1);
    expect(
      server.calls.some(
        (c) => c.length === undefined && c.sha256 === sha(v2.payload),
      ),
    ).toBe(true);
  });

  it("refuses a 206 carrying another ETag the same way (falls back)", async () => {
    const { v1, v2 } = await chain();
    const server = rangeServer(v1, v2);
    const e = engine({ server, stamp: chunkStamp(v1) });
    await e.load();
    await e.ensure([v1.packId]);
    server.etag = `"${"0".repeat(64)}"`;
    const [install] = await e.ensureReleases([target(v2)]);
    expect(install!.payloadSha256).toBe(sha(v2.payload));
    expect(server.ranges()).toHaveLength(1);
  });

  it("resumes an interrupted chunk install from the run journal, reusing the completed run", async () => {
    const { v1, v2 } = await chain();
    const server = rangeServer(v1, v2);
    const storage = memoryPackStorage();
    const e = engine({ server, storage, stamp: chunkStamp(v1) });
    await e.load();
    await e.ensure([v1.packId]);
    server.cutRange = 2;
    await expect(e.ensureReleases([target(v2)])).rejects.toMatchObject({
      code: "network-error",
      detail: "chunk",
    });
    const inflight = e.state().inflight[v2.packId];
    expect(inflight?.strategy).toBe("chunk");
    const journal = JSON.parse(storage.journals.get(inflight!.planId)!);
    expect(journal).toMatchObject({ v: 1, index: v2.indexSha256, runs: 3 });
    expect(journal.bitmap).toBe("01");
    // The next ensure resumes: run 0 is re-hashed from the output and reused; runs 1 and 2 go
    // out again.
    server.cutRange = 0;
    server.calls.length = 0;
    const [install] = await e.ensureReleases([target(v2)]);
    expect(install!.payloadSha256).toBe(sha(v2.payload));
    expect(server.ranges().map((r) => r.offset)).toEqual([131072, 327680]);
    expect(sha(await installedBytes(storage, e, v2.packId))).toBe(
      sha(v2.payload),
    );
  });

  it("copies a chunk that moved from pack A to pack B out of A's installed payload", async () => {
    // A holds y; B v1 holds p q; B v2 is p y q. B v2's own bundle holds every chunk, so without
    // A's payload as a seed y would be fetched.
    const a = await containerPack({
      packId: "djdl.a",
      version: "1.0.0",
      seq: 1,
      chunks: ["x", "y"],
      bundles: [["x", "y"]],
    });
    const b1 = await containerPack({
      packId: "djdl.b",
      version: "1.0.0",
      seq: 1,
      chunks: ["p", "q"],
      bundles: [["p", "q"]],
    });
    const b2 = await containerPack({
      packId: "djdl.b",
      version: "1.1.0",
      seq: 2,
      chunks: ["p", "y", "q"],
      bundles: [["p", "y", "q"]],
    });
    const server = rangeServer(a, b1, b2);
    const storage = memoryPackStorage();
    const e = engine({ server, storage, stamp: chunkStamp(a, b1) });
    await e.load();
    await e.ensure([a.packId, b1.packId]);
    expect(storage.indexes.size).toBe(2);
    server.calls.length = 0;
    const [install] = await e.ensureReleases([target(b2)]);
    expect(install!.payloadSha256).toBe(sha(b2.payload));
    // Every chunk came from a seed: no range request at all, and the planner agrees.
    expect(server.ranges()).toHaveLength(0);
    expect(plannedChunkRequests(b2, b1, a)).toBe(1);
    expect(sha(await installedBytes(storage, e, b2.packId))).toBe(
      sha(b2.payload),
    );
  });

  it("drops a seed index no root install names any more", async () => {
    const { v1, v2 } = await chain();
    const v3 = await containerPack({
      packId: v1.packId,
      version: "1.2.0",
      seq: 3,
      chunks: ["a", "g", "c", "h"],
      bundles: [
        ["a", "b", "c", "d", "e", "f"],
        ["g", null, "h", "i", null, "j"],
      ],
    });
    const server = rangeServer(v1, v2, v3);
    const storage = memoryPackStorage();
    const e = engine({ server, storage, stamp: chunkStamp(v1) });
    await e.load();
    await e.ensure([v1.packId]);
    await e.ensureReleases([target(v2)]);
    await e.ensureReleases([target(v3)]);
    // v1 is neither active nor previous now.
    expect([...storage.indexes.keys()].sort()).toEqual(
      [v2.indexSha256, v3.indexSha256].sort(),
    );
  });
});

describe("chunkRangeFetch: the exact Content-Range rule (plans/P4-10.md §2.5)", () => {
  const bundle = "ab".repeat(32);
  const body = (n: number) =>
    (async function* () {
      yield new Uint8Array(n).fill(7);
    })();
  const answer =
    (r: Partial<ObjectResponse> & { status: number }) =>
    async (): Promise<ObjectResponse> => ({
      contentRange: null,
      chunks: body(10),
      ...r,
    });
  const read = async (it: AsyncIterable<Uint8Array>) => {
    let n = 0;
    for await (const c of it) n += c.byteLength;
    return n;
  };

  it("sends one bounded range with If-Range on the bundle hash", async () => {
    let seen: unknown = null;
    const f = chunkRangeFetch(async (req) => {
      seen = req;
      return {
        status: 206,
        contentRange: "bytes 100-109/1000",
        etag: `"${bundle}"`,
        chunks: body(10),
      };
    });
    const r = await f({ bundle, offset: 100, length: 10 });
    expect(seen).toEqual({
      sha256: bundle,
      offset: 100,
      length: 10,
      ifRange: `"${bundle}"`,
    });
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(await read(r.chunks)).toBe(10);
  });

  it("accepts a range clipped at the object's end (the applier then reports truncation)", async () => {
    const f = chunkRangeFetch(
      answer({
        status: 206,
        contentRange: "bytes 100-104/105",
        chunks: body(5),
      }),
    );
    const r = await f({ bundle, offset: 100, length: 10 });
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(await read(r.chunks)).toBe(5);
  });

  it("cuts a body that runs past the accepted range", async () => {
    const f = chunkRangeFetch(
      answer({ status: 206, contentRange: "bytes 0-9/1000", chunks: body(50) }),
    );
    const r = await f({ bundle, offset: 0, length: 10 });
    if (r.status === "ok") expect(await read(r.chunks)).toBe(10);
    else throw new Error("refused");
  });

  for (const [name, res] of [
    ["a 200", { status: 200 }],
    ["a 206 without Content-Range", { status: 206 }],
    ["another start", { status: 206, contentRange: "bytes 99-108/1000" }],
    [
      "a shorter range not at the end",
      { status: 206, contentRange: "bytes 100-105/1000" },
    ],
    ["a longer range", { status: 206, contentRange: "bytes 100-110/1000" }],
    [
      "an end past the size",
      { status: 206, contentRange: "bytes 100-109/109" },
    ],
    ["an unknown size", { status: 206, contentRange: "bytes 100-109/*" }],
    [
      "a multipart answer",
      { status: 206, contentRange: "bytes 100-109/1000, 0-1/1000" },
    ],
    [
      "another ETag",
      {
        status: 206,
        contentRange: "bytes 100-109/1000",
        etag: `"${"cd".repeat(32)}"`,
      },
    ],
    [
      "a weak ETag",
      {
        status: 206,
        contentRange: "bytes 100-109/1000",
        etag: `W/"${bundle}"`,
      },
    ],
  ] as const)
    it(`refuses ${name}`, async () => {
      const f = chunkRangeFetch(answer(res as ObjectResponse));
      expect((await f({ bundle, offset: 100, length: 10 })).status).toBe(
        "refused",
      );
    });
});
