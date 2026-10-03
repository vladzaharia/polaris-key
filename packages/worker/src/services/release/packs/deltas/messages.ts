/**
 * The two message shapes on the lazy-delta queue (`pkey-deltas-<env>`, P4-17):
 *
 *   pair      `{type: "lazy-delta-pair", v: 1, product, deliverable, from, to}` — one encode job.
 *             Sent by the nightly sweep (pairs that turned hot) and by the consumer itself (an
 *             R2 event fanned out into its likely bases). Under 1 KB, against Queues' 128 KB.
 *   R2 event  the documented R2 event-notification body (notes/S-08 §2.6): `{account, bucket,
 *             object: {key, size, eTag}, action, eventTime, …}`, sent by the bucket's
 *             object-create rule on the `blobs/sha256/` and `gated/blobs/sha256/` prefixes when a
 *             payload (or any other blob) is stored. It names only the new object.
 *
 * Anything else is malformed and acknowledged without work (a poison message must not cycle
 * through retries into the DLQ).
 */

import { parseKey } from "../../../../core/blobs.js";
import { isDeliverableId } from "@polaris-key/manifest";

export const PAIR_MESSAGE_TYPE = "lazy-delta-pair";

export interface PairMessage {
  type: typeof PAIR_MESSAGE_TYPE;
  v: 1;
  product: string;
  deliverable: string;
  /** The base's `payload.sha256`. */
  from: string;
  /** The target's `payload.sha256`. */
  to: string;
}

export interface BlobEventMessage {
  type: "blob-created";
  /** The new object's key: `blobs/sha256/<hex>` or `gated/blobs/sha256/<hex>`. */
  key: string;
  sha256: string;
  gated: boolean;
}

export type DeltaMessage = PairMessage | BlobEventMessage;

const HEX64 = /^[0-9a-f]{64}$/;
const PRODUCT = /^[a-z0-9-]{1,64}$/;
const CREATE_ACTIONS = new Set([
  "PutObject",
  "CopyObject",
  "CompleteMultipartUpload",
]);

export function pairMessage(
  product: string,
  deliverable: string,
  from: string,
  to: string,
): PairMessage {
  return { type: PAIR_MESSAGE_TYPE, v: 1, product, deliverable, from, to };
}

/** The message, or null when it is neither shape. */
export function parseDeltaMessage(body: unknown): DeltaMessage | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (b.type === PAIR_MESSAGE_TYPE) {
    if (
      b.v !== 1 ||
      typeof b.product !== "string" ||
      !PRODUCT.test(b.product) ||
      !isDeliverableId(b.deliverable) ||
      typeof b.from !== "string" ||
      !HEX64.test(b.from) ||
      typeof b.to !== "string" ||
      !HEX64.test(b.to)
    )
      return null;
    return pairMessage(b.product, b.deliverable, b.from, b.to);
  }
  const object = b.object as Record<string, unknown> | undefined;
  if (
    object &&
    typeof object === "object" &&
    typeof object.key === "string" &&
    typeof b.action === "string" &&
    CREATE_ACTIONS.has(b.action)
  ) {
    const parsed = parseKey(object.key);
    if (!parsed || parsed.area !== "locked" || parsed.kind !== "blob")
      return null;
    return {
      type: "blob-created",
      key: object.key,
      sha256: parsed.sha256,
      gated: parsed.gated,
    };
  }
  return null;
}
