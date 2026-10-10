/**
 * P4-17 — lazy hot-pair deltas: the policy as a table, the queue consumer and the nightly sweep
 * against an in-memory D1 and the R2 mock, and the structural checks that keep every byte of
 * work out of the request Worker (notes/S-08 §6; the brief's acceptance criteria).
 *
 * The consumer runs the REAL encoder (`@polaris-key/zstd-wasm/encoder`, Node entry) on small
 * payloads, except where a fake stands in for a failure the real one cannot be made to produce
 * (a verify mismatch).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ZstdEncodeError,
  patchFrom,
  type PatchFromOptions,
  type PatchFromResult,
} from "@polaris-key/zstd-wasm/encoder";
import { decodeWithPrefix } from "@polaris-key/zstd-wasm";
import { makeTestDb } from "./helpers.js";
import { seedProduct, NOW } from "./seed.js";
import { R2Mock, asR2, installDigestStream } from "./r2Mock.js";
import { bytesFrom, sha } from "./packFixture.js";
import type { SqliteDb } from "../src/db/sqlite.js";
import { blobKey, deltaKey } from "../src/core/assets/blobs.js";
import {
  MAX_DEMAND_ROWS_PER_DEVICE,
  boundedPackInstalls,
  hotPairs,
  refreshDemand,
  recordPackInstalls,
} from "../src/core/assets/deltaDemand.js";
import {
  handleDeltaBatch,
  processDeltaMessage,
  type DeltaConsumerDeps,
} from "../src/services/release/packs/deltas/consumer.js";
import {
  pairMessage,
  parseDeltaMessage,
} from "../src/services/release/packs/deltas/messages.js";
import {
  baseRefusal,
  maxWorthwhileFrame,
  shouldQueue,
  worthKeeping,
  type PairFacts,
} from "../src/services/release/packs/deltas/policy.js";
import { sweepLazyDeltas } from "../src/services/release/packs/deltas/sweep.js";
import { lazyDeltaRow } from "../src/services/release/packs/deltas/store.js";
import { runScheduledMaintenance } from "../src/scheduled.js";
import type { Env } from "../src/platform/env.js";

installDigestStream();

const HERE = dirname(fileURLToPath(import.meta.url));
const P = "djdl";
const PACK = "djdl.levels";
const MiB = 1024 * 1024;

// ── The policy, as a table ───────────────────────────────────────────────────────────────────

const A = "a".repeat(64);
const B = "b".repeat(64);
function facts(
  over: Partial<PairFacts> = {},
  to: Partial<PairFacts["to"]> = {},
) {
  return {
    from: { sha256: A, size: 10 * MiB, codec: "zstd" },
    to: {
      sha256: B,
      size: 10 * MiB,
      codec: "zstd",
      layout: "container",
      ciDeltaFroms: [],
      ...to,
    },
    devices: 25,
    hotDevices: 25,
    maxBytes: 32 * MiB,
    generatedToday: 0,
    dailyCap: 20,
    ...over,
  } satisfies PairFacts;
}

describe("the lazy-delta policy", () => {
  it.each([
    ["a hot pair", facts(), null],
    [
      "a pair below the threshold is not queued",
      facts({ devices: 24 }),
      "below-threshold",
    ],
    [
      "a hot pair with a CI delta from this base is not queued",
      facts({}, { ciDeltaFroms: [A] }),
      "ci-delta",
    ],
    [
      "a CI delta from another base does not count",
      facts({}, { ciDeltaFroms: [B] }),
      null,
    ],
    ["the same payload", facts({}, { sha256: A }), "same-payload"],
    ["a tree target", facts({}, { layout: "tree" }), "not-container"],
    ["an unknown codec", facts({}, { codec: "brotli" }), "unusable-codec"],
    [
      "a target over the cap is refused",
      facts({}, { size: 32 * MiB + 1 }),
      "over-worker-cap",
    ],
    [
      "a base over the cap is refused",
      facts({ from: { sha256: A, size: 40 * MiB, codec: "none" } }),
      "over-worker-cap",
    ],
    ["a pair at the cap", facts({}, { size: 32 * MiB }), null],
    ["the daily cap", facts({ generatedToday: 20 }), "daily-cap"],
  ])("%s", (_name, f, reason) => {
    const got = shouldQueue(f);
    expect(got.ok ? null : got.reason).toBe(reason);
  });

  it("refuses a base that begins with 37 A4 30 EC", () => {
    expect(baseRefusal(new Uint8Array([0x37, 0xa4, 0x30, 0xec, 1]))).toBe(
      "dictionary-base",
    );
    expect(baseRefusal(new Uint8Array([0x28, 0xb5, 0x2f, 0xfd]))).toBe(null);
    expect(baseRefusal(new Uint8Array([0x37, 0xa4]))).toBe(null);
  });

  it("refuses savings under 30% or under 1 MiB", () => {
    // 10 MiB alternative: 30% is 3 MiB, so the frame must be under 7 MiB.
    expect(worthKeeping(7 * MiB - 1, 10 * MiB)).toBe(true);
    expect(worthKeeping(7 * MiB, 10 * MiB)).toBe(false);
    // 2 MiB alternative: 30% is 0.6 MiB < 1 MiB, so 1 MiB of saving binds.
    expect(worthKeeping(MiB - 1, 2 * MiB)).toBe(true);
    expect(worthKeeping(MiB + 1, 2 * MiB)).toBe(false);
    // Under 1 MiB nothing can save 1 MiB.
    expect(maxWorthwhileFrame(MiB)).toBe(null);
    expect(worthKeeping(10, 900_000)).toBe(false);
  });
});

// ── Telemetry bounds ─────────────────────────────────────────────────────────────────────────

describe("packInstalls bounds", () => {
  it("keeps at most 8 valid entries, drops unknown fields and cuts failureStage", () => {
    const ok = { pack: PACK, from: A, to: B, strategy: "chunk" };
    const got = boundedPackInstalls([
      {
        ...ok,
        extra: "x",
        bytes: 10,
        durationMs: 5,
        fallbackUsed: true,
        failureStage: "s".repeat(300),
      },
      { ...ok, from: "A".repeat(64) },
      { ...ok, pack: "Not A Pack" },
      { ...ok, strategy: "" },
      "nope",
      ...Array.from({ length: 10 }, () => ok),
    ])!;
    expect(got[0]).toEqual({
      ...ok,
      bytes: 10,
      durationMs: 5,
      fallbackUsed: true,
      failureStage: "s".repeat(128),
    });
    // The first 8 raw entries are read: 1 valid, 4 malformed, 3 more valid.
    expect(got).toHaveLength(4);
    expect(boundedPackInstalls("x")).toBeUndefined();
    expect(boundedPackInstalls([{}])).toBeUndefined();
  });
});

// ── A pack world in D1 and R2 ────────────────────────────────────────────────────────────────

interface Rel {
  releaseId: string;
  version: string;
  seq: number;
  payload: Uint8Array;
  recordSha: string;
}

interface World {
  db: SqliteDb;
  r2: R2Mock;
  env: Pick<Env, "LAZY_DELTAS" | "LAZY_DELTA_MAX_BYTES" | "DELTA_QUEUE">;
  sent: unknown[];
  v1: Rel;
  v2: Rel;
  deps(over?: Partial<DeltaConsumerDeps>): DeltaConsumerDeps;
}

function jwsOf(payload: unknown): string {
  return `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
}

function variantOf(payload: Uint8Array, deltas: unknown[] = []) {
  return {
    variant: {},
    payload: { size: payload.length, sha256: sha(payload) },
    full: {
      sha256: sha(payload),
      bytes: payload.length,
      size: payload.length,
      codec: "none",
    },
    files: {
      format: "pkey-files/1",
      layout: "container",
      sha256: "c".repeat(64),
      bytes: 10,
      size: 10,
      codec: "none",
      gaps: { sha256: "d".repeat(64), bytes: 1, size: 1, codec: "none" },
    },
    deltas,
  };
}

async function addRelease(
  db: SqliteDb,
  r2: R2Mock,
  version: string,
  seq: number,
  payload: Uint8Array,
  opts: { deltas?: unknown[]; entitlement?: string } = {},
): Promise<Rel> {
  const releaseId = `${PACK}@${version}`;
  const record = {
    schemaVersion: 1,
    aud: P,
    deliverable: PACK,
    kind: "pack",
    version,
    seq,
    issuedAt: NOW,
    type: "godot.pck",
    formatVersion: 4,
    ...(opts.entitlement ? { entitlement: opts.entitlement } : {}),
    variants: [variantOf(payload, opts.deltas)],
  };
  const jws = jwsOf(record);
  const recordSha = sha(jws);
  await db.run(
    `INSERT INTO release_metadata (product, release_id, version, created_at, modified_at, deliverable_id, seq)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    P,
    releaseId,
    version,
    NOW,
    NOW,
    PACK,
    seq,
  );
  await db.run(
    `INSERT INTO release_records (product, deliverable_id, release_id, seq, kind, record_sha256, kid, jws, ingested_at)
     VALUES (?, ?, ?, ?, 'pack', ?, 'k', ?, ?)`,
    P,
    PACK,
    releaseId,
    seq,
    recordSha,
    jws,
    NOW,
  );
  const key = blobKey(sha(payload), { gated: opts.entitlement !== undefined });
  r2.seed(key, payload, { withSha256: true });
  await db.run(
    `INSERT OR IGNORE INTO blob_objects (storage_key, sha256, size, kind, gated, verified_at, created_at)
     VALUES (?, ?, ?, 'blob', ?, ?, ?)`,
    key,
    sha(payload),
    payload.length,
    opts.entitlement ? 1 : 0,
    NOW,
    NOW,
  );
  await db.run(
    `INSERT INTO blob_refs (product, storage_key, ref_kind, ref_id, created_at) VALUES (?, ?, 'pack-object', ?, ?)`,
    P,
    key,
    releaseId,
    NOW,
  );
  return { releaseId, version, seq, payload, recordSha };
}

/** A 256 KiB base and a target that differs in a few places. */
function pairBytes(): [Uint8Array, Uint8Array] {
  const v1 = bytesFrom("lazy/v1", 256 * 1024);
  const v2 = v1.slice();
  for (let i = 0; i < 16; i++) v2[i * 9973]! ^= 0x5a;
  return [v1, v2];
}

async function demand(
  db: SqliteDb,
  from: string,
  to: string,
  devices: number,
  strategy = "chunk",
  at = NOW,
  prefix = "dev",
): Promise<void> {
  for (let i = 0; i < devices; i++)
    await db.run(
      `INSERT OR REPLACE INTO delta_demand_devices
         (product, deliverable_id, from_sha256, to_sha256, device_id, strategy, seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      P,
      PACK,
      from,
      to,
      `${prefix}-${i}`,
      strategy,
      at,
    );
}

async function world(
  o: { v1?: Uint8Array; v2Deltas?: unknown[]; enabled?: boolean } = {},
): Promise<World> {
  const db = makeTestDb();
  await seedProduct(db, P);
  if (o.enabled !== false)
    await db.run(
      `INSERT INTO lazy_delta_settings (product, enabled, hot_devices, daily_cap, updated_at)
       VALUES (?, 1, 3, 5, ?)`,
      P,
      NOW,
    );
  const r2 = new R2Mock();
  const [b1, b2] = pairBytes();
  const v1 = await addRelease(db, r2, "1.0.0", 1, o.v1 ?? b1);
  const v2 = await addRelease(db, r2, "1.1.0", 2, b2, { deltas: o.v2Deltas });
  const sent: unknown[] = [];
  const queue = {
    send: async (m: unknown) => void sent.push(m),
    sendBatch: async () => undefined,
  } as unknown as Queue<unknown>;
  const env = { LAZY_DELTAS: "on", DELTA_QUEUE: queue };
  return {
    db,
    r2,
    env,
    sent,
    v1,
    v2,
    deps: (over = {}) => ({
      env,
      db,
      bucket: asR2(r2),
      queue,
      now: NOW,
      encode: patchFrom,
      // The cheapest other strategy: the full object (the fixture's indexes are not stored).
      alternative: async () => 10 * MiB,
      ...over,
    }),
  };
}

const pairOf = (w: World) =>
  pairMessage(P, PACK, sha(w.v1.payload), sha(w.v2.payload));
const keyOf = (w: World) =>
  deltaKey(sha(w.v1.payload), sha(w.v2.payload), "zstd-patch-from");

describe("the queue consumer", () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
    await demand(w.db, sha(w.v1.payload), sha(w.v2.payload), 3);
  });

  it("a hot pair produces one upload at deltas/<from>/<to>.zstd-patch-from and one descriptor", async () => {
    const out = await processDeltaMessage(pairOf(w), 1, w.deps());
    expect(out).toEqual({ kind: "ack", result: "ready" });
    const key = keyOf(w);
    expect(w.r2.putAttempts.filter((k) => k === key)).toEqual([key]);
    const row = await lazyDeltaRow(
      w.db,
      P,
      sha(w.v1.payload),
      sha(w.v2.payload),
    );
    expect(row?.state).toBe("ready");
    expect(row?.storageKey).toBe(key);
    const d = row!.descriptor!;
    expect(d).toMatchObject({
      method: "zstd-patch-from",
      scope: "payload",
      from: sha(w.v1.payload),
      to: sha(w.v2.payload),
      size: w.v2.payload.length,
      memBytes: w.v1.payload.length + w.v2.payload.length,
      windowLog: 19,
    });
    // The stored frame is the descriptor's artifact and decodes over the base to the target.
    const obj = (await w.r2.get(key)) as R2ObjectBody;
    const frame = new Uint8Array(await obj.arrayBuffer());
    expect({ sha256: sha(frame), bytes: frame.length }).toEqual(d.artifact);
    expect(
      sha(decodeWithPrefix(frame, w.v1.payload, w.v2.payload.length, 20)),
    ).toBe(sha(w.v2.payload));
    // Its bookkeeping: a delta object, held by the product's `lazy-delta` ref.
    expect(
      await w.db.first(
        "SELECT kind, gated, size FROM blob_objects WHERE storage_key = ?",
        key,
      ),
    ).toEqual({ kind: "delta", gated: 0, size: frame.length });
    expect(
      await w.db.all(
        "SELECT ref_kind, ref_id FROM blob_refs WHERE storage_key = ?",
        key,
      ),
    ).toEqual([{ ref_kind: "lazy-delta", ref_id: PACK }]);
  });

  it("a duplicate event does nothing", async () => {
    await processDeltaMessage(pairOf(w), 1, w.deps());
    const puts = w.r2.putAttempts.length;
    let encodes = 0;
    const out = await processDeltaMessage(
      pairOf(w),
      1,
      w.deps({ encode: async (o) => (encodes++, patchFrom(o)) }),
    );
    expect(out).toEqual({ kind: "ack", result: "exists:ready" });
    expect(w.r2.putAttempts.length).toBe(puts);
    expect(encodes).toBe(0);
  });

  it("records an object a dead job left behind instead of encoding again", async () => {
    w.r2.seed(keyOf(w), new Uint8Array([1, 2, 3]), { withSha256: true });
    let encodes = 0;
    const out = await processDeltaMessage(
      pairOf(w),
      1,
      w.deps({ encode: async (o) => (encodes++, patchFrom(o)) }),
    );
    expect(out.result).toBe("ready:existing");
    expect(encodes).toBe(0);
    const row = await lazyDeltaRow(
      w.db,
      P,
      sha(w.v1.payload),
      sha(w.v2.payload),
    );
    expect(row?.descriptor?.artifact).toEqual({
      sha256: sha(new Uint8Array([1, 2, 3])),
      bytes: 3,
    });
  });

  it("an encode whose verify hash is not `to` is discarded", async () => {
    const out = await processDeltaMessage(
      pairOf(w),
      1,
      w.deps({
        encode: async (): Promise<PatchFromResult> => {
          throw new ZstdEncodeError(
            "verify",
            "the frame decoded to another target",
          );
        },
      }),
    );
    expect(out.result).toBe("refused:verify");
    expect(w.r2.has(keyOf(w))).toBe(false);
    expect(
      (await lazyDeltaRow(w.db, P, sha(w.v1.payload), sha(w.v2.payload)))
        ?.reason,
    ).toBe("verify");
  });

  it("refuses below the threshold without a mark, and a CI-delta pair with one", async () => {
    const cold = await world();
    await demand(cold.db, sha(cold.v1.payload), sha(cold.v2.payload), 2);
    expect(
      (await processDeltaMessage(pairOf(cold), 1, cold.deps())).result,
    ).toBe("refused:below-threshold");
    expect(
      await lazyDeltaRow(
        cold.db,
        P,
        sha(cold.v1.payload),
        sha(cold.v2.payload),
      ),
    ).toBe(null);

    const [b1] = pairBytes();
    const ci = await world({
      v2Deltas: [
        {
          method: "zstd-patch-from",
          scope: "payload",
          from: sha(b1),
          memBytes: 10,
          artifact: { sha256: "e".repeat(64), bytes: 5 },
        },
      ],
    });
    await demand(ci.db, sha(ci.v1.payload), sha(ci.v2.payload), 5);
    expect((await processDeltaMessage(pairOf(ci), 1, ci.deps())).result).toBe(
      "refused:ci-delta",
    );
    expect(ci.r2.putAttempts).toEqual([]);
  });

  it("refuses a base that begins with 37 A4 30 EC after decoding it", async () => {
    const [b1] = pairBytes();
    b1.set([0x37, 0xa4, 0x30, 0xec], 0);
    const m = await world({ v1: b1 });
    await demand(m.db, sha(m.v1.payload), sha(m.v2.payload), 3);
    expect((await processDeltaMessage(pairOf(m), 1, m.deps())).result).toBe(
      "refused:dictionary-base",
    );
    expect(m.r2.has(keyOf(m))).toBe(false);
  });

  it("refuses a pair over the cap, and one that cannot save enough, before encoding", async () => {
    let encodes = 0;
    const counting = async (o: PatchFromOptions) => (encodes++, patchFrom(o));
    const capped = await processDeltaMessage(
      pairOf(w),
      1,
      w.deps({
        env: { ...w.env, LAZY_DELTA_MAX_BYTES: "1000" },
        encode: counting,
      }),
    );
    expect(capped.result).toBe("refused:over-worker-cap");
    // An encoder refusal of the sizes is over the cap only when a side really is.
    const sizes = await world();
    await demand(sizes.db, sha(sizes.v1.payload), sha(sizes.v2.payload), 3);
    const malformed = await processDeltaMessage(
      pairOf(sizes),
      1,
      sizes.deps({
        encode: async () => {
          throw new ZstdEncodeError("input-size", "malformed");
        },
      }),
    );
    expect(malformed.result).toBe("refused:malformed-sizes");
    const small = await world();
    await demand(small.db, sha(small.v1.payload), sha(small.v2.payload), 3);
    const out = await processDeltaMessage(
      pairOf(small),
      1,
      small.deps({ alternative: async () => 900_000, encode: counting }),
    );
    expect(out.result).toBe("refused:savings");
    expect(encodes).toBe(0);
  });

  it("does nothing while LAZY_DELTAS is off or the product has not opted in", async () => {
    expect(
      (
        await processDeltaMessage(
          pairOf(w),
          1,
          w.deps({ env: { LAZY_DELTAS: "off" } }),
        )
      ).result,
    ).toBe("disabled");
    const off = await world({ enabled: false });
    expect((await processDeltaMessage(pairOf(off), 1, off.deps())).result).toBe(
      "disabled",
    );
    expect(w.r2.putAttempts).toEqual([]);
  });

  it("fans an R2 event for a new payload out to the bases devices sit on", async () => {
    // Four devices moved TO v1 (they sit on it); v2's full object is the new object.
    await demand(
      w.db,
      "f".repeat(64),
      sha(w.v1.payload),
      4,
      "full",
      NOW,
      "base",
    );
    const event = {
      account: "acct",
      bucket: "polaris-key-blobs-prod",
      object: { key: blobKey(sha(w.v2.payload)), eTag: "x" },
      action: "PutObject",
      eventTime: "2026-10-03T00:00:00Z",
    };
    const out = await processDeltaMessage(event, 1, w.deps());
    expect(out.result).toBe("fanned-out:1");
    // An object of at most 1 MiB is never a payload worth a delta: no lookup, no wait.
    const small = { ...event, object: { ...event.object, size: 1024 * 1024 } };
    expect((await processDeltaMessage(small, 1, w.deps())).result).toBe(
      "too-small",
    );
    expect(w.sent).toEqual([pairOf(w)]);
    // A blob no pack record names: nothing; one only an opted-in product uploaded: wait for it.
    const unknown = { ...event, object: { key: blobKey("9".repeat(64)) } };
    expect((await processDeltaMessage(unknown, 1, w.deps())).result).toBe(
      "not-a-pack-object",
    );
    const staged = blobKey("8".repeat(64));
    await w.db.run(
      `INSERT INTO blob_objects (storage_key, sha256, size, kind, gated, verified_at, created_at)
       VALUES (?, ?, 1, 'blob', 0, ?, ?)`,
      staged,
      "8".repeat(64),
      NOW,
      NOW,
    );
    await w.db.run(
      `INSERT INTO blob_refs (product, storage_key, ref_kind, ref_id, created_at) VALUES (?, ?, 'pack-upload', ?, ?)`,
      P,
      staged,
      PACK,
      NOW,
    );
    const early = { ...event, object: { key: staged } };
    expect(await processDeltaMessage(early, 1, w.deps())).toEqual({
      kind: "retry",
      delaySeconds: 300,
      result: "not-ingested",
    });
    expect((await processDeltaMessage(early, 3, w.deps())).result).toBe(
      "not-a-payload",
    );
  });

  it("parses only the two shapes, and acknowledges anything else", async () => {
    expect(parseDeltaMessage({ type: "lazy-delta-pair", v: 2 })).toBe(null);
    expect(
      parseDeltaMessage({ object: { key: "deltas/x" }, action: "PutObject" }),
    ).toBe(null);
    expect(
      parseDeltaMessage({
        object: { key: blobKey(A) },
        action: "DeleteObject",
      }),
    ).toBe(null);
    expect(
      parseDeltaMessage({
        object: { key: `gated/${blobKey(A)}` },
        action: "CopyObject",
      }),
    ).toEqual({
      type: "blob-created",
      key: `gated/${blobKey(A)}`,
      sha256: A,
      gated: true,
      size: null,
    });
    expect((await processDeltaMessage("junk", 1, w.deps())).result).toBe(
      "malformed",
    );
  });

  it("acks or retries each message on its own, and a throw retries only that one", async () => {
    const calls: string[] = [];
    const msg = (body: unknown, id: string) => ({
      id,
      body,
      attempts: 1,
      timestamp: new Date(),
      ack: () => calls.push(`${id}:ack`),
      retry: (o?: { delaySeconds?: number }) =>
        calls.push(`${id}:retry:${o?.delaySeconds}`),
    });
    const batch = {
      queue: "pkey-deltas-test",
      messages: [msg("junk", "m1"), msg(pairOf(w), "m2")],
      ackAll: () => undefined,
      retryAll: () => undefined,
    } as unknown as MessageBatch<unknown>;
    await handleDeltaBatch(batch, () =>
      w.deps({
        encode: async () => {
          throw new Error("boom");
        },
      }),
    );
    expect(calls).toEqual(["m1:ack", "m2:retry:60"]);
  });
});

// ── Report ingest, the sweep and the scheduled step ──────────────────────────────────────────

describe("demand and the nightly sweep", () => {
  it("counts a pair once per device, ignores delta installs as demand, and needs the opt-in", async () => {
    const w = await world();
    const e = {
      pack: PACK,
      from: sha(w.v1.payload),
      to: sha(w.v2.payload),
      strategy: "chunk",
    };
    await recordPackInstalls(w.env, w.db, P, "d1", [e, e], NOW);
    await recordPackInstalls(w.env, w.db, P, "d1", [e], NOW + 10);
    await recordPackInstalls(w.env, w.db, P, "d2", [e], NOW);
    await recordPackInstalls(
      w.env,
      w.db,
      P,
      "d3",
      [{ ...e, strategy: "delta" }],
      NOW,
    );
    await refreshDemand(w.db, P, NOW + 20);
    expect(await hotPairs(w.db, P, 1, 10)).toEqual([
      { deliverableId: PACK, from: e.from, to: e.to, devices: 2 },
    ]);
    // One device holds at most MAX_DEMAND_ROWS_PER_DEVICE rows: the newest are kept.
    for (let i = 0; i < 40; i++)
      await recordPackInstalls(
        w.env,
        w.db,
        P,
        "spammer",
        [{ ...e, to: i.toString(16).padStart(64, "0") }],
        NOW + 100 + i,
      );
    const kept = await w.db.all<{ to_sha256: string }>(
      "SELECT to_sha256 FROM delta_demand_devices WHERE device_id = 'spammer' ORDER BY seen_at",
    );
    expect(kept).toHaveLength(MAX_DEMAND_ROWS_PER_DEVICE);
    expect(kept[0]!.to_sha256).toBe(
      (40 - MAX_DEMAND_ROWS_PER_DEVICE).toString(16).padStart(64, "0"),
    );
    const off = await world({ enabled: false });
    expect(await recordPackInstalls(off.env, off.db, P, "d1", [e], NOW)).toBe(
      0,
    );
    expect(
      await recordPackInstalls({ LAZY_DELTAS: "off" }, w.db, P, "d9", [e], NOW),
    ).toBe(0);
  });

  it("queues hot pairs only, within the daily cap, and marks cold deltas", async () => {
    const w = await world();
    const from = sha(w.v1.payload);
    const to = sha(w.v2.payload);
    await demand(w.db, from, to, 2);
    expect((await sweepLazyDeltas(w.env, w.db, P, NOW)).queued).toBe(0);
    await demand(w.db, from, to, 3);
    expect((await sweepLazyDeltas(w.env, w.db, P, NOW)).queued).toBe(1);
    expect(w.sent).toEqual([pairMessage(P, PACK, from, to)]);

    // Generate it, then let 31 days pass without a device on the pair.
    await processDeltaMessage(pairOf(w), 1, w.deps());
    w.sent.length = 0;
    const later = NOW + 31 * 86400;
    const swept = await sweepLazyDeltas(w.env, w.db, P, later);
    expect(swept).toMatchObject({ queued: 0, cold: 1 });
    expect((await lazyDeltaRow(w.db, P, from, to))?.state).toBe("cold");
    expect(
      await w.db.all("SELECT * FROM blob_refs WHERE storage_key = ?", keyOf(w)),
    ).toEqual([]);
  });

  it("runs from the maintenance tick for opted-in products only while LAZY_DELTAS is on", async () => {
    const w = await world();
    const on = await runScheduledMaintenance(w.db, NOW, {
      ...w.env,
    } as unknown as Env);
    expect(Object.keys(on.counts)).toContain(`lazyDeltas:${P}`);
    expect(on.failures).toEqual({});
    const off = await runScheduledMaintenance(w.db, NOW, {
      LAZY_DELTAS: "off",
    } as unknown as Env);
    expect(Object.keys(off.counts)).not.toContain(`lazyDeltas:${P}`);
  });
});

// ── Structure: no byte work outside the consumer ─────────────────────────────────────────────

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("the request Worker cannot encode", () => {
  const SRC = join(HERE, "..", "src");

  it("only src/deltasEntry.ts imports the encoder", () => {
    // A value import (a type-only import erases at build time and bundles nothing).
    const VALUE_IMPORT =
      /^import\s+(?!type\b)[^;]*?from\s+"@polaris-key\/zstd-wasm\/encoder"/m;
    const importers = sources(SRC)
      .filter((f) => VALUE_IMPORT.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    expect(importers).toEqual(["deltasEntry.ts"]);
  });

  it("the report path imports no codec and no queue", () => {
    for (const f of ["core/devices.ts", "core/assets/deltaDemand.ts"]) {
      const text = readFileSync(join(SRC, f), "utf8");
      expect(text).not.toMatch(/zstd-wasm/);
      expect(text).not.toMatch(/DELTA_QUEUE\.send|\.send\(/);
      expect(text).not.toMatch(/BLOBS/);
    }
  });

  it("binds the queue per environment: a producer here, the consumer and DLQ there", () => {
    const main = readFileSync(join(HERE, "..", "wrangler.toml"), "utf8");
    const consumer = readFileSync(
      join(HERE, "..", "wrangler.deltas.toml"),
      "utf8",
    );
    for (const env of ["prod", "staging", "dev"]) {
      expect(main).toMatch(
        new RegExp(
          `\\[\\[env\\.${env}\\.queues\\.producers\\]\\]\\nbinding = "DELTA_QUEUE"\\nqueue = "pkey-deltas-${env}"`,
        ),
      );
      expect(consumer).toMatch(
        new RegExp(
          `\\[\\[env\\.${env}\\.queues\\.consumers\\]\\]\\nqueue = "pkey-deltas-${env}"\\nmax_batch_size = 1\\nmax_batch_timeout = 5\\nmax_retries = 3\\nmax_concurrency = 1\\ndead_letter_queue = "pkey-deltas-dlq-${env}"`,
        ),
      );
      expect(consumer).toContain(`bucket_name = "polaris-key-blobs-${env}"`);
    }
    // A-13: the console decides everywhere (default off, never `on` at deploy time); no consumer
    // in the request Worker.
    expect(main.match(/^LAZY_DELTAS = "runtime"$/gm)).toHaveLength(3);
    expect(consumer.match(/^LAZY_DELTAS = "runtime"$/gm)).toHaveLength(3);
    expect(main).not.toMatch(/^LAZY_DELTAS = "on"$/m);
    expect(consumer).not.toMatch(/^LAZY_DELTAS = "on"$/m);
    // (HA-05: the request Worker consumes `pkey-assets-<env>` only, never a delta queue.)
    expect(main).not.toMatch(/queues\.consumers\]\]\nqueue = "pkey-deltas-/);
    expect(consumer).toMatch(/^main = "src\/deltasEntry\.ts"$/m);
    expect(consumer).toMatch(/^cpu_ms = 60000$/m);
    // The deploy job ships the consumer too, with the same environment.
    const deploy = readFileSync(
      join(HERE, "..", "..", "..", ".github", "workflows", "deploy.yml"),
      "utf8",
    );
    expect(deploy).toContain(
      'npx wrangler deploy -c wrangler.deltas.toml --env "$ENV"',
    );
    // The queues (and the token's Queues Edit) are checked before any migration runs.
    const preflight = deploy.indexOf(
      'npx wrangler queues info "pkey-deltas-dlq-$ENV"',
    );
    expect(preflight).toBeGreaterThan(0);
    expect(
      deploy.indexOf('npx wrangler queues info "pkey-deltas-$ENV"'),
    ).toBeGreaterThan(0);
    expect(preflight).toBeLessThan(deploy.indexOf("d1 migrations apply"));
  });
});
