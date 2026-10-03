/**
 * The lazy-delta policy (P4-17; notes/E5 §3.2, notes/S-08 §6): which hot (from, to) pairs are
 * worth a server-generated `zstd-patch-from` delta, as pure functions over integers and hashes.
 * The sweep asks `shouldQueue` before it enqueues a pair, the consumer asks it again (the facts
 * may have moved) and then `baseRefusal` on the decoded base and `worthKeeping` on the frame.
 *
 * The A7 §3.2 publish rules hold for a lazy delta as for a CI one: never against a base that
 * begins with zstd's dictionary magic `37 A4 30 EC` (a decoder would read the base as a
 * dictionary, not raw content); one bare frame with its content size and checksum; the window
 * the CLI picks from the target, recorded in the descriptor; `memBytes` the base size plus the
 * payload size (WIRE-CONTRACT-V4 §2.6).
 */

import { ZSTD_DICTIONARY_MAGIC } from "@polaris-key/protocol/packs";

/** The one method v1 generates. */
export const LAZY_DELTA_METHOD = "zstd-patch-from";
/** The encoder level (S-08 §4.1: level 9 single-threaded is within 0.9–7.4% of the CLI's `-19`
 *  on real pack pairs, at a fraction of the memory and time). */
export const LAZY_DELTA_LEVEL = 9;
/** The per-side cap: max(from, to) ≤ 32 MiB keeps an encode near 84 MiB of linear memory. */
export const DEFAULT_LAZY_DELTA_MAX_BYTES = 33_554_432;
/** A delta must save more than this fraction of the cheapest other strategy… */
export const MIN_SAVING_FRACTION = 0.3;
/** …and more than this many bytes. */
export const MIN_SAVING_BYTES = 1_048_576;

/** Why a pair gets no lazy delta. Recorded on the pair's row when it is permanent. */
export type LazyDeltaRefusal =
  /** from and to are the same payload. */
  | "same-payload"
  /** Fewer devices than the product's threshold moved between them. */
  | "below-threshold"
  /** The target is not a `container` variant (a tree has no whole payload to patch). */
  | "not-container"
  /** The target's record already carries a CI delta from this base. */
  | "ci-delta"
  /** A `full` object is in a codec the encoder cannot read. */
  | "unusable-codec"
  /** A side is larger than the Worker cap: the evidence P4-17b (a Container tier) waits for. */
  | "over-worker-cap"
  /** The product generated its daily cap already (transient: not recorded). */
  | "daily-cap"
  /** The decoded base begins with `37 A4 30 EC`. */
  | "dictionary-base"
  /** The frame would not save enough against the cheapest other strategy. */
  | "savings"
  /** The product holds no ref to one of the two objects (possession, THREAT-MODEL §3). */
  | "no-ref"
  /** The encoder's verify decode did not give the target back. */
  | "verify";

/** Refusals worth remembering: the facts behind them do not change for this pair. */
export const PERMANENT_REFUSALS: ReadonlySet<LazyDeltaRefusal> = new Set([
  "same-payload",
  "not-container",
  "ci-delta",
  "unusable-codec",
  "over-worker-cap",
  "dictionary-base",
  "savings",
  "verify",
]);

export interface PolicySide {
  /** `payload.sha256`. */
  sha256: string;
  /** `payload.size`. */
  size: number;
  /** The `full` object's codec. */
  codec: string;
}

export interface PairFacts {
  from: PolicySide;
  to: PolicySide & {
    /** The target variant's `files.layout`. */
    layout: string;
    /** The `from` of every `zstd-patch-from` payload delta its record already carries. */
    ciDeltaFroms: readonly string[];
  };
  /** Distinct devices that moved (or, for an R2 event's join, sit on `from`). */
  devices: number;
  /** The product's hot threshold. */
  hotDevices: number;
  /** The per-side cap in bytes. */
  maxBytes: number;
  /** Lazy deltas the product generated in the last day. */
  generatedToday: number;
  /** The product's daily cap. */
  dailyCap: number;
}

export type PolicyAnswer =
  | { ok: true }
  | { ok: false; reason: LazyDeltaRefusal };

const CODECS = new Set(["zstd", "none"]);

/**
 * Whether a pair should be encoded, in this order: the same payload, below the threshold, a
 * target that is not a container, an existing CI delta from this base, an unusable codec, a side
 * over the cap, and the daily cap.
 */
export function shouldQueue(f: PairFacts): PolicyAnswer {
  const no = (reason: LazyDeltaRefusal): PolicyAnswer => ({
    ok: false,
    reason,
  });
  if (f.from.sha256 === f.to.sha256) return no("same-payload");
  if (f.devices < f.hotDevices) return no("below-threshold");
  if (f.to.layout !== "container") return no("not-container");
  if (f.to.ciDeltaFroms.includes(f.from.sha256)) return no("ci-delta");
  if (!CODECS.has(f.from.codec) || !CODECS.has(f.to.codec))
    return no("unusable-codec");
  if (f.from.size > f.maxBytes || f.to.size > f.maxBytes)
    return no("over-worker-cap");
  if (f.generatedToday >= f.dailyCap) return no("daily-cap");
  return { ok: true };
}

/** `dictionary-base` when the decoded base begins with `37 A4 30 EC`, else null. */
export function baseRefusal(head: Uint8Array): LazyDeltaRefusal | null {
  if (head.byteLength < 4) return null;
  let hex = "";
  for (const b of head.subarray(0, 4)) hex += b.toString(16).padStart(2, "0");
  return hex === ZSTD_DICTIONARY_MAGIC ? "dictionary-base" : null;
}

/**
 * The largest frame worth keeping against `alternativeBytes` (the cheapest strategy the device
 * would otherwise use): one that saves more than 30% AND more than 1 MiB. Null when no frame
 * can (the alternative is itself small), so the consumer refuses before encoding.
 */
export function maxWorthwhileFrame(alternativeBytes: number): number | null {
  const byFraction =
    Math.ceil(alternativeBytes * (1 - MIN_SAVING_FRACTION)) - 1;
  const byBytes = alternativeBytes - MIN_SAVING_BYTES - 1;
  const max = Math.min(byFraction, byBytes);
  return max >= 1 ? max : null;
}

/** Whether a frame of `frameBytes` saves enough against `alternativeBytes`. */
export function worthKeeping(
  frameBytes: number,
  alternativeBytes: number,
): boolean {
  const max = maxWorthwhileFrame(alternativeBytes);
  return max !== null && frameBytes <= max;
}

/** The per-side cap from the `LAZY_DELTA_MAX_BYTES` var (a positive integer), else 32 MiB. */
export function maxBytesFrom(raw: string | undefined): number {
  const n = Number((raw ?? "").trim());
  return Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_LAZY_DELTA_MAX_BYTES;
}

/** The descriptor of a generated delta: the record's payload-delta shape plus `to`, `size` and
 *  the window. What the feed's delta menu will carry once its shape is planned (P4-17's
 *  Corrections: the menu is a wire change). */
export interface LazyDeltaDescriptor {
  method: typeof LAZY_DELTA_METHOD;
  scope: "payload";
  from: string;
  to: string;
  /** The target's decoded size. */
  size: number;
  /** Base size plus payload size (WIRE-CONTRACT-V4 §2.6). */
  memBytes: number;
  /** The frame's window log, as the encoder chose it. */
  windowLog: number;
  artifact: { sha256: string; bytes: number };
}

export function lazyDescriptor(args: {
  from: PolicySide;
  to: PolicySide;
  windowLog: number;
  artifact: { sha256: string; bytes: number };
}): LazyDeltaDescriptor {
  return {
    method: LAZY_DELTA_METHOD,
    scope: "payload",
    from: args.from.sha256,
    to: args.to.sha256,
    size: args.to.size,
    memBytes: args.from.size + args.to.size,
    windowLog: args.windowLog,
    artifact: { sha256: args.artifact.sha256, bytes: args.artifact.bytes },
  };
}
