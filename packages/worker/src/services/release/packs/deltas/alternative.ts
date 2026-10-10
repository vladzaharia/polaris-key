/**
 * The cheapest strategy a device on `from` would otherwise use to reach `to` (notes/E5 §3.2's
 * "against the cheapest strategy the device would otherwise use"), from the records and their
 * indexes alone: client-core's own `planTarget` and `plan`, with every strategy allowed and the
 * base installed with its chunk ids and file hashes. Integer arithmetic over two chunk indexes
 * and two files indexes; no payload byte is read.
 *
 * Indexes are read one at a time under `MAX_PUBLISHED_INDEX_BYTES` (decision 36) and dropped
 * before the next, BEFORE the encode starts, so their memory is garbage by then. An index that
 * cannot be read only removes that strategy from the comparison (the full object always
 * remains), which can only make a delta look more worthwhile, never unsafe.
 */

import { MAX_PUBLISHED_INDEX_BYTES } from "@polaris-key/manifest";
import {
  parseChunkIndex,
  parseFilesIndex,
  plan,
  planTarget,
} from "@polaris-key/client-core/packs";
import { decode as zstdDecode } from "@polaris-key/zstd-wasm";
import { blobKey } from "../../../../core/assets/blobs.js";
import type { PayloadSide } from "./records.js";

async function readIndex(
  bucket: R2Bucket,
  ref: { sha256: string; bytes: number; size: number },
  gated: boolean,
): Promise<Uint8Array | null> {
  if (
    ref.size > MAX_PUBLISHED_INDEX_BYTES ||
    ref.bytes > MAX_PUBLISHED_INDEX_BYTES
  )
    return null;
  const obj = await bucket.get(blobKey(ref.sha256, { gated }));
  if (!obj || !("arrayBuffer" in obj) || obj.size !== ref.bytes) return null;
  return new Uint8Array(await obj.arrayBuffer());
}

const opts = {
  decode: (frame: Uint8Array, size: number) => zstdDecode(frame, size),
  maxBytes: MAX_PUBLISHED_INDEX_BYTES,
};

/** The chunk ids and file hashes of the base, and the target's parsed indexes. */
async function facts(bucket: R2Bucket, side: PayloadSide) {
  const v = side.variant;
  let files = null;
  try {
    const bytes = v.files ? await readIndex(bucket, v.files, side.gated) : null;
    if (bytes) {
      const r = await parseFilesIndex(bytes, v.files, v, opts);
      if (r.ok) files = r.index;
    }
  } catch {
    files = null;
  }
  let chunks = null;
  try {
    const c = v.chunks;
    const bytes = c ? await readIndex(bucket, c, side.gated) : null;
    if (c && bytes) {
      const r = await parseChunkIndex(bytes, c, v.payload, opts);
      if (r.ok) chunks = r.index;
    }
  } catch {
    chunks = null;
  }
  return { files, chunks };
}

/**
 * The bytes of the cheapest strategy other than a lazy delta (the CI deltas of the target
 * included, though the policy has already refused a pair with one from this base).
 */
export async function cheapestAlternative(
  bucket: R2Bucket,
  from: PayloadSide,
  to: PayloadSide,
): Promise<number> {
  const base = await facts(bucket, from);
  const baseChunkIds = base.chunks
    ? base.chunks.records.map((r) => r[0])
    : null;
  const baseFiles = base.files ? base.files.files.map((f) => f.sha256) : null;
  const target = await facts(bucket, to);
  const t = planTarget(
    to.variant,
    to.recordSha256,
    target.files,
    target.chunks,
  );
  const result = plan({
    target: t,
    installed: [
      {
        release: from.recordSha256,
        payloadSha256: from.variant.payload.sha256,
        chunks: baseChunkIds ? { ids: baseChunkIds } : null,
        files: baseFiles,
      },
    ],
    caps: {
      strategies: ["delta", "chunk", "file", "full"],
      patchMethods: ["zstd-patch-from"],
      transports: [],
      memBudget: Number.MAX_SAFE_INTEGER,
      freeDisk: Number.MAX_SAFE_INTEGER,
    },
  });
  if ("bytes" in result && typeof result.bytes === "number")
    return result.bytes;
  return to.variant.full.bytes;
}
