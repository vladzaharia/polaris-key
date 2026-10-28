// The upload planner (WIRE-CONTRACT-V5 §13.8.1): from a stored size and the collection's
// `files.delta`, the mode of a file transfer, the part size of a multipart one and its part count.
// `begin` answers the same numbers; a client plans first so it can pick `format` and slice parts.
//
//   too_large  over SYNC_FILE_MAX_BYTES (1 GiB)
//   chunks     files.delta and at least 1 MiB (chunked, never multipart)
//   single     at most SYNC_SINGLE_PUT_MAX_BYTES (16 MiB): one PUT
//   multipart  otherwise: partBytes = clamp(8 MiB .. 64 MiB, ceil(size / 9,999) up to a MiB)

import {
  SYNC_FILE_MAX_BYTES,
  SYNC_MAX_PARTS,
  SYNC_PART_MAX_BYTES,
  SYNC_PART_MIN_BYTES,
  SYNC_PART_ROUND_BYTES,
  SYNC_SINGLE_PUT_MAX_BYTES,
} from "@polaris-key/protocol/sync";

/** A file below this is never chunked, even when its collection has `files.delta`. */
export const SYNC_CHUNKED_MIN_BYTES = 1_048_576;

export type TransferMode = "single" | "multipart" | "chunks" | "too_large";

export interface TransferPlan {
  mode: TransferMode;
  /** The size of every part but the last; only for `multipart`. */
  partBytes: number | null;
  /** The part count; only for `multipart`. */
  parts: number | null;
}

/** The stored size is the sealed size in E2E mode (`sealedFileSize`). */
export function planTransfer(size: number, delta: boolean): TransferPlan {
  if (!Number.isSafeInteger(size) || size < 0)
    throw new RangeError("transfer size");
  if (size > SYNC_FILE_MAX_BYTES)
    return { mode: "too_large", partBytes: null, parts: null };
  if (delta && size >= SYNC_CHUNKED_MIN_BYTES)
    return { mode: "chunks", partBytes: null, parts: null };
  if (size <= SYNC_SINGLE_PUT_MAX_BYTES)
    return { mode: "single", partBytes: null, parts: null };
  const rounded =
    Math.ceil(Math.ceil(size / SYNC_MAX_PARTS) / SYNC_PART_ROUND_BYTES) *
    SYNC_PART_ROUND_BYTES;
  const partBytes = Math.min(
    Math.max(SYNC_PART_MIN_BYTES, rounded),
    SYNC_PART_MAX_BYTES,
  );
  return { mode: "multipart", partBytes, parts: Math.ceil(size / partBytes) };
}

/** Part `n` (from 1) of a multipart plan as a half-open byte range of the stored file. */
export function partRange(
  plan: TransferPlan,
  size: number,
  n: number,
): { start: number; end: number } {
  if (
    plan.mode !== "multipart" ||
    plan.partBytes === null ||
    plan.parts === null
  )
    throw new RangeError("not a multipart plan");
  if (!Number.isInteger(n) || n < 1 || n > plan.parts)
    throw new RangeError("part number");
  const start = (n - 1) * plan.partBytes;
  return { start, end: Math.min(size, start + plan.partBytes) };
}
