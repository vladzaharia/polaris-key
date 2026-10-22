/**
 * The one namer of `CloudSyncDO` (U-05.7; plans/U-05-slices.md §2): every call to a person's
 * object goes through here, and nothing else in `src/` touches the `CLOUD_SYNC` binding.
 *
 * The object is `idFromName("<product>:<subject>")`, so the id is a function of exactly the pair
 * the Worker resolved, and the pair is sent in the body as well: the object pins it on its first
 * write and answers `403 pin_mismatch` to any other. The caller passes the subject it took from
 * `syncAccess` (the authenticated principal); a request body never supplies one.
 *
 * Product slugs are `[a-z0-9-]` and subjects are base32 pairwise ids, neither holds `:`, so two
 * different pairs can never share a name.
 */

import type { Env } from "../../../platform/env.js";
import type {
  CloudSyncError,
  CloudSyncOp,
  CloudSyncReply,
  DoPin,
  ExportDocument,
} from "./protocol.js";

/** The object's name for one person on one product. */
export function cloudSyncObjectName(pin: DoPin): string {
  return `${pin.product}:${pin.subject}`;
}

export class CloudSyncDoError extends Error {
  constructor(
    readonly status: number,
    readonly code: CloudSyncError["error"] | "unbound" | "bad_reply",
  ) {
    super(`CloudSyncDO answered ${status} ${code}`);
  }
}

type DistributiveOmit<T, K extends keyof never> = T extends unknown
  ? Omit<T, K>
  : never;

/** One operation against the person's object. Throws `CloudSyncDoError` on a refusal. */
export async function callCloudSync<O extends CloudSyncOp["op"]>(
  env: Pick<Env, "CLOUD_SYNC">,
  pin: DoPin,
  op: DistributiveOmit<Extract<CloudSyncOp, { op: O }>, keyof DoPin>,
): Promise<Extract<CloudSyncReply, { op: O }>> {
  const ns = env.CLOUD_SYNC as DurableObjectNamespace | undefined;
  if (!ns) throw new CloudSyncDoError(503, "unbound");
  const stub = ns.get(ns.idFromName(cloudSyncObjectName(pin)));
  const res = await stub.fetch("https://cloud-sync.do/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...op, product: pin.product, subject: pin.subject }),
  });
  const body = (await res.json().catch(() => null)) as
    | CloudSyncReply
    | CloudSyncError
    | null;
  if (!res.ok) {
    throw new CloudSyncDoError(
      res.status,
      body && "error" in body ? body.error : "bad_reply",
    );
  }
  if (!body || !("op" in body) || body.op !== op.op)
    throw new CloudSyncDoError(502, "bad_reply");
  return body as Extract<CloudSyncReply, { op: O }>;
}

/** Everything the person's object holds, or `null` when it was never written. */
export async function exportCloudSync(
  env: Pick<Env, "CLOUD_SYNC">,
  pin: DoPin,
): Promise<ExportDocument | null> {
  return (await callCloudSync<"exportAll">(env, pin, { op: "exportAll" }))
    .document;
}

/** Remove the object's data (its alarm first, so nothing wakes on a ghost). */
export async function deleteCloudSync(
  env: Pick<Env, "CLOUD_SYNC">,
  pin: DoPin,
): Promise<void> {
  await callCloudSync<"deleteAll">(env, pin, { op: "deleteAll" });
}

/** Whether the object holds anything. Reads create nothing. */
export async function cloudSyncHoldsData(
  env: Pick<Env, "CLOUD_SYNC">,
  pin: DoPin,
): Promise<boolean> {
  const r = await callCloudSync<"usage">(env, pin, { op: "usage" });
  return !r.empty;
}
