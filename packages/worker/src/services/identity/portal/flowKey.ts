import { hashKey } from "../../../platform/crypto.js";
import type { Env } from "../../../platform/env.js";
import { artefactRef, type ArtefactRef } from "../../../core/singleUse.js";

/**
 * Single-use store address (`core/singleUse.ts`, I-02) of an in-flight portal OIDC sign-in,
 * by its `state`. Both portal credentials live there rather than in KV because KV `get` then
 * `delete` is not atomic (G15): two racing callbacks, or two clicks on one magic link, could
 * both be served. The store's `consume` hands a record out at most once.
 *
 * R12-04: both portal credentials (the OIDC `state` and the magic-link token) used to be the
 * key name verbatim, so a listing alone was a credential dump: a live `state` beside its PKCE
 * `verifier`, and a working magic-link token beside the victim's email. The address is the
 * secret's hash under `KEY_HASH_PEPPER`, so a listing stays inert.
 *
 * Exported for tests that plant or inspect a flow record.
 */
export async function portalFlowKey(
  env: Env,
  state: string,
): Promise<ArtefactRef> {
  return artefactRef("portal-flow", await hashKey(state, env.KEY_HASH_PEPPER));
}
