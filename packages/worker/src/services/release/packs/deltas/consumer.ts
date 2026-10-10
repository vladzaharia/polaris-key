/**
 * The lazy-delta queue consumer (P4-17, notes/S-08 §6). It runs ONLY in the dedicated consumer
 * Worker (`src/deltasEntry.ts`, `wrangler.deltas.toml`: batch 1, concurrency 1), never in the
 * request Worker, so an encode never shares an isolate's 128 MB with a request or a second
 * encode. Everything it touches is injected (`DeltaConsumerDeps`), so the tests drive it with
 * fakes and the request Worker's bundle never carries the encoder.
 *
 * A pair job, all in one invocation:
 *
 *   1. opt-in      the deployment's `LAZY_DELTAS` and the product's `lazy_delta_settings`;
 *   2. idempotent  a `release_lazy_deltas` row for the pair ends the job (a duplicate event or a
 *                  re-sent pair is a no-op); so does an object already at the delta key, which
 *                  is recorded instead of re-encoded (a job that died after its upload);
 *   3. policy      `shouldQueue` on the records: threshold, container, no CI delta from this
 *                  base, codecs, the 32 MiB cap (`over-worker-cap`, counted for P4-17b), the
 *                  daily cap; then possession (the product holds refs to both objects);
 *   4. savings     the cheapest other strategy (`alternative.ts`); a frame that cannot save 30%
 *                  and 1 MiB is refused before encoding, and the encode is abandoned the moment
 *                  it outgrows that;
 *   5. encode      level 9 in WASM, inputs streamed from R2 and checked against the payload
 *                  hashes the CI-signed records name, the frame verified by decoding over the
 *                  base (`@polaris-key/zstd-wasm/encoder`); a base starting `37 A4 30 EC` is
 *                  refused; an encode whose verify is not `to` is discarded;
 *   6. publish     the bare frame at `deltas/<from>/<to>.zstd-patch-from` (under `gated/` when
 *                  either side is gated) through `putVerified`, its `blob_objects` row, the
 *                  product's `lazy-delta` ref, and the `ready` row with its descriptor.
 *
 * An R2 event names one new object; one of at most 1 MiB is acknowledged at once (it cannot be
 * a payload worth a delta). Its pack-object holders say which pack release and variant it is the
 * `full` object of; its likely bases are the payloads most devices sit on
 * (`installedBase`), and each becomes a pair job on the same queue. An event that arrives
 * before the record's ingest is retried a few times, then dropped.
 *
 * Retries: a thrown error retries the message (`max_retries` = 3, then the DLQ); refusals and
 * no-ops acknowledge it; known-transient states (the record not yet ingested, an object claimed
 * by the collector) retry with a delay.
 */

import type {
  EncodeInput,
  PatchFromOptions,
  PatchFromResult,
} from "@polaris-key/zstd-wasm/encoder";
import type { Db } from "../../../../db/types.js";
import type { Env } from "../../../../platform/env.js";
import {
  checksumHex,
  deltaKey,
  hasRef,
  putVerified,
  recordObject,
  recordRef,
} from "../../../../core/assets/blobs.js";
import {
  HOT_WINDOW_SECONDS,
  installedBase,
  lazyDeltasEnabled,
  lazyDeltasOn,
  pairDemand,
  payloadDevices,
} from "../../../../core/assets/deltaDemand.js";
import { cheapestAlternative } from "./alternative.js";
import {
  pairMessage,
  parseDeltaMessage,
  type BlobEventMessage,
  type PairMessage,
} from "./messages.js";
import {
  LAZY_DELTA_LEVEL,
  LAZY_DELTA_METHOD,
  MIN_SAVING_BYTES,
  PERMANENT_REFUSALS,
  baseRefusal,
  lazyDescriptor,
  maxWorthwhileFrame,
  shouldQueue,
  worthKeeping,
  type LazyDeltaRefusal,
} from "./policy.js";
import {
  ciDeltaFroms,
  findPair,
  packObjectHolders,
  releaseSides,
  uploadHolders,
  type PayloadSide,
} from "./records.js";
import {
  LAZY_DELTA_REF_KIND,
  generatedSince,
  lazyDeltaRow,
  recordReady,
  recordRefused,
  type PairKey,
} from "./store.js";
import { platformSetting } from "../../../../core/settings/platformRead.js";

/** Pair jobs one R2 event fans out into, at most. */
export const EVENT_FANOUT = 3;
/** Attempts an event or a pair waits for its record's ingest before it is dropped. */
export const INGEST_WAIT_ATTEMPTS = 3;
/** The delay between those attempts, in seconds. */
export const INGEST_WAIT_SECONDS = 300;

export interface DeltaConsumerDeps {
  env: Pick<Env, "LAZY_DELTAS" | "LAZY_DELTA_MAX_BYTES">;
  db: Db;
  bucket: R2Bucket;
  /** The same queue, to fan an R2 event out into pair jobs. */
  queue?: Queue<unknown>;
  now: number;
  /** `@polaris-key/zstd-wasm/encoder`'s `patchFrom` (a fake in the Node tests). */
  encode(opts: PatchFromOptions): Promise<PatchFromResult>;
  /** The cheapest other strategy's bytes (default: `cheapestAlternative`). */
  alternative?(
    bucket: R2Bucket,
    from: PayloadSide,
    to: PayloadSide,
  ): Promise<number>;
}

export type DeltaOutcome =
  | { kind: "ack"; result: string }
  | { kind: "retry"; delaySeconds: number; result: string };

const ack = (result: string): DeltaOutcome => ({ kind: "ack", result });
const retry = (delaySeconds: number, result: string): DeltaOutcome => ({
  kind: "retry",
  delaySeconds,
  result,
});

/** The window log the CLI (and the encoder) picks for a target of `size` bytes. */
export function cliWindowLog(size: number): number {
  const bits = size <= 1 ? 0 : Math.floor(Math.log2(size));
  return Math.min(31, Math.max(10, bits + 1));
}

function encodeInput(bucket: R2Bucket, side: PayloadSide): EncodeInput {
  const { payload, full } = side.variant;
  return {
    size: payload.size,
    bytes: full.bytes,
    // Passed as recorded: an unknown codec is the encoder's refusal, never read as zstd.
    codec: full.codec as EncodeInput["codec"],
    sha256: payload.sha256,
    read: async function* () {
      const obj = await bucket.get(side.fullKey);
      if (!obj || !("body" in obj))
        throw new Error(`lazy delta: ${side.fullKey} is not stored`);
      yield* obj.body as unknown as AsyncIterable<Uint8Array>;
    },
  };
}

async function refuse(
  db: Db,
  key: PairKey,
  reason: LazyDeltaRefusal,
  now: number,
): Promise<DeltaOutcome> {
  if (PERMANENT_REFUSALS.has(reason)) await recordRefused(db, key, reason, now);
  return ack(`refused:${reason}`);
}

/** Store the object's bookkeeping and the ready row. False: the collector claimed it. */
async function publish(
  deps: DeltaConsumerDeps,
  key: PairKey,
  storageKey: string,
  gated: boolean,
  pair: { from: PayloadSide; to: PayloadSide },
  artifact: { sha256: string; bytes: number },
  windowLog: number,
): Promise<boolean> {
  const { db, now } = deps;
  const recorded = await recordObject(
    db,
    {
      storageKey,
      sha256: artifact.sha256,
      size: artifact.bytes,
      kind: "delta",
      gated,
    },
    now,
  );
  if (!recorded) return false;
  await recordRef(
    db,
    {
      product: key.product,
      storageKey,
      refKind: LAZY_DELTA_REF_KIND,
      refId: key.deliverableId,
    },
    now,
  );
  const side = (s: PayloadSide) => ({
    sha256: s.variant.payload.sha256,
    size: s.variant.payload.size,
    codec: s.variant.full.codec,
  });
  await recordReady(
    db,
    key,
    storageKey,
    lazyDescriptor({
      from: side(pair.from),
      to: side(pair.to),
      windowLog,
      artifact,
    }),
    now,
  );
  return true;
}

async function runPair(
  m: PairMessage,
  attempts: number,
  deps: DeltaConsumerDeps,
): Promise<DeltaOutcome> {
  const { env, db, bucket, now } = deps;
  const settings = await lazyDeltasEnabled(env, db, m.product);
  if (!settings) return ack("disabled");
  const existing = await lazyDeltaRow(db, m.product, m.from, m.to);
  if (existing) return ack(`exists:${existing.state}`);
  const pair = await findPair(db, m.product, m.deliverable, m.from, m.to);
  if (!pair)
    return attempts < INGEST_WAIT_ATTEMPTS
      ? retry(INGEST_WAIT_SECONDS, "unknown-pair")
      : ack("unknown-pair");
  const key: PairKey = {
    product: m.product,
    deliverableId: m.deliverable,
    buildId: pair.to.buildId,
    from: m.from,
    to: m.to,
  };
  const since = now - HOT_WINDOW_SECONDS;
  const devices = Math.max(
    await pairDemand(db, m.product, m.deliverable, m.from, m.to, since),
    await payloadDevices(db, m.product, m.deliverable, m.from, since),
  );
  const maxBytes = await platformSetting(env, db, "deltas.lazy.maxBytes");
  const verdict = shouldQueue({
    from: {
      sha256: m.from,
      size: pair.from.variant.payload.size,
      codec: pair.from.variant.full.codec,
    },
    to: {
      sha256: m.to,
      size: pair.to.variant.payload.size,
      codec: pair.to.variant.full.codec,
      layout: pair.to.variant.files.layout,
      ciDeltaFroms: ciDeltaFroms(pair.to.variant),
    },
    devices,
    hotDevices: settings.hotDevices,
    maxBytes,
    generatedToday: await generatedSince(db, m.product, now - 86400),
    dailyCap: settings.dailyCap,
  });
  if (!verdict.ok) return refuse(db, key, verdict.reason, now);
  if (
    !(await hasRef(db, m.product, pair.from.fullKey)) ||
    !(await hasRef(db, m.product, pair.to.fullKey))
  )
    return ack("refused:no-ref");

  const gated = pair.from.gated || pair.to.gated;
  const storageKey = deltaKey(m.from, m.to, LAZY_DELTA_METHOD, { gated });
  // A job that died after its upload left the object: record it rather than encode again.
  const head = await bucket.head(storageKey);
  const headSha = head ? checksumHex(head) : null;
  if (head && headSha) {
    const ok = await publish(
      deps,
      key,
      storageKey,
      gated,
      pair,
      { sha256: headSha, bytes: head.size },
      cliWindowLog(pair.to.variant.payload.size),
    );
    return ok ? ack("ready:existing") : retry(3600, "claimed");
  }

  const alternative = await (deps.alternative ?? cheapestAlternative)(
    bucket,
    pair.from,
    pair.to,
  );
  const maxFrame = maxWorthwhileFrame(alternative);
  if (maxFrame === null) return refuse(db, key, "savings", now);

  let result: PatchFromResult;
  try {
    result = await deps.encode({
      from: encodeInput(bucket, pair.from),
      to: encodeInput(bucket, pair.to),
      level: LAZY_DELTA_LEVEL,
      maxInputBytes: maxBytes,
      maxFrameBytes: maxFrame,
    });
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    if (code === "frame-too-large") return refuse(db, key, "savings", now);
    if (code === "verify") return refuse(db, key, "verify", now);
    if (code === "input-size") {
      // Only a real side over the cap is `over-worker-cap` (the P4-17b evidence); a codec the
      // encoder cannot read, or sizes it refuses as malformed, are their own reasons.
      const sides = [pair.from.variant, pair.to.variant];
      if (sides.some((v) => v.full.codec !== "zstd" && v.full.codec !== "none"))
        return refuse(db, key, "unusable-codec", now);
      if (
        sides.some((v) => v.payload.size > maxBytes || v.full.bytes > maxBytes)
      )
        return refuse(db, key, "over-worker-cap", now);
      return refuse(db, key, "malformed-sizes", now);
    }
    // A stored object that does not match its record, or no memory: never a delta, never a
    // permanent mark (the next sweep may find it fixed), never a retry storm.
    if (code === "input" || code === "input-digest" || code === "memory")
      return ack(`failed:${code}`);
    throw e;
  }
  const dictionary = baseRefusal(result.baseHead);
  if (dictionary) return refuse(db, key, dictionary, now);
  if (!worthKeeping(result.frame.byteLength, alternative))
    return refuse(db, key, "savings", now);

  let artifact = { sha256: result.sha256, bytes: result.frame.byteLength };
  const put = await putVerified(bucket, storageKey, result.frame, {
    sha256: result.sha256,
    size: result.frame.byteLength,
  });
  if (!put.ok) {
    if (put.reason !== "exists")
      throw new Error(`lazy delta upload refused: ${put.reason}`);
    // Another job won the race: keep its (verified) object.
    const other = await bucket.head(storageKey);
    const otherSha = other ? checksumHex(other) : null;
    if (!other || !otherSha) throw new Error("lazy delta object vanished");
    artifact = { sha256: otherSha, bytes: other.size };
  }
  const ok = await publish(
    deps,
    key,
    storageKey,
    gated,
    pair,
    artifact,
    result.windowLog,
  );
  return ok ? ack("ready") : retry(3600, "claimed");
}

async function runBlobEvent(
  m: BlobEventMessage,
  attempts: number,
  deps: DeltaConsumerDeps,
): Promise<DeltaOutcome> {
  const { env, db, now, queue } = deps;
  if (!(await lazyDeltasOn(env, db))) return ack("disabled");
  // Most objects under the payload prefixes are file blobs and indexes. A `full` object of at
  // most 1 MiB can never be beaten by 1 MiB (`MIN_SAVING_BYTES`), so a small object is not
  // worth a lookup, let alone the retries that wait for a record's ingest.
  if (m.size !== null && m.size <= MIN_SAVING_BYTES) return ack("too-small");
  const holders = await packObjectHolders(db, m.key);
  if (holders.length === 0) {
    for (const product of await uploadHolders(db, m.key))
      if (await lazyDeltasEnabled(env, db, product))
        return attempts < INGEST_WAIT_ATTEMPTS
          ? retry(INGEST_WAIT_SECONDS, "not-ingested")
          : ack("not-a-payload");
    return ack("not-a-pack-object");
  }
  if (!queue) return ack("no-queue");
  let sent = 0;
  for (const h of holders) {
    const settings = await lazyDeltasEnabled(env, db, h.product);
    if (!settings) continue;
    const sides = (await releaseSides(db, h.product, h.releaseId)).filter(
      (s) => s.fullKey === m.key && !s.yanked,
    );
    for (const s of sides) {
      const to = s.variant.payload.sha256;
      const bases = await installedBase(
        db,
        h.product,
        s.deliverableId,
        settings.hotDevices,
        now - HOT_WINDOW_SECONDS,
        EVENT_FANOUT + 1,
      );
      for (const b of bases
        .filter((x) => x.payload !== to)
        .slice(0, EVENT_FANOUT)) {
        if (await lazyDeltaRow(db, h.product, b.payload, to)) continue;
        await queue.send(
          pairMessage(h.product, s.deliverableId, b.payload, to),
        );
        sent++;
      }
    }
  }
  return ack(`fanned-out:${sent}`);
}

/** One message's outcome. Throws only for an unexpected failure (the queue then retries it). */
export async function processDeltaMessage(
  body: unknown,
  attempts: number,
  deps: DeltaConsumerDeps,
): Promise<DeltaOutcome> {
  const m = parseDeltaMessage(body);
  if (!m) return ack("malformed");
  return m.type === "blob-created"
    ? runBlobEvent(m, attempts, deps)
    : runPair(m, attempts, deps);
}

/**
 * The `queue` handler's body: each message on its own (`ack`, or `retry` with its delay; a throw
 * retries just that message), so one poison message never redelivers its batch (S-08 §4.4).
 */
export async function handleDeltaBatch(
  batch: MessageBatch<unknown>,
  deps: (now: number) => DeltaConsumerDeps,
): Promise<DeltaOutcome[]> {
  const out: DeltaOutcome[] = [];
  for (const msg of batch.messages) {
    let outcome: DeltaOutcome;
    try {
      outcome = await processDeltaMessage(
        msg.body,
        msg.attempts,
        deps(Math.floor(Date.now() / 1000)),
      );
    } catch (e) {
      outcome = retry(
        60,
        `error:${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (outcome.kind === "ack") msg.ack();
    else msg.retry({ delaySeconds: outcome.delaySeconds });
    out.push(outcome);
  }
  return out;
}
