import type { Env } from "../platform/env.js";
import {
  artefactRef,
  deleteArtefact,
  putArtefact,
  type SingleUseKind,
} from "./singleUse.js";

// One atomic "first caller wins" claim over the single-use store, for the places that
// used KV `get` then `put`/`delete` as a replay or redemption guard (webhook deliveries, attestation
// challenges). KV is not atomic across isolates; the Durable Object serialises the writes.

/** Claim `(kind, id)` for `ttlSec`. True for exactly one of any number of concurrent callers.
 *  Throws when the store is unreachable, so an unrecordable claim is never treated as granted. */
export function claimOnce(
  env: Env,
  kind: SingleUseKind,
  id: string,
  ttlSec: number,
): Promise<boolean> {
  return putArtefact(env, artefactRef(kind, id), "1", ttlSec, {
    ifAbsent: true,
  });
}

/** Give a claim back (a delivery whose processing failed may be redelivered). */
export function releaseClaim(
  env: Env,
  kind: SingleUseKind,
  id: string,
): Promise<void> {
  return deleteArtefact(env, artefactRef(kind, id));
}
