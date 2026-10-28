/// <reference types="@cloudflare/workers-types" />

/**
 * The step-up mark of the link offer (WIRE-CONTRACT-V5 §12.11.4; I-43.1).
 *
 * A same-device sign-in leaves one mark, kind `signin-fresh`, keyed by `(product, device id)` and
 * live for 300 seconds. Only two places write it: `authorization_code` at `token` once the device
 * is bound, and `choice/complete` on a grant that `authorization_code` earned (`GrantRecord.fresh`).
 * The device code, nearby approval, restore and the token exchange never write it: they are not
 * proof that the person is at this device now.
 *
 * The link route (I-43.2) reads the mark (the offer list) and spends it (the link itself). A spend
 * is one atomic take, so of any number of concurrent links at most one finds the mark.
 */

import type { Env } from "../../../platform/env.js";
import {
  artefactRef,
  consumeArtefact,
  getArtefact,
  putArtefact,
  type ArtefactRef,
} from "../../../core/singleUse.js";

/** How long a step-up lasts. */
const FRESH_SIGNIN_TTL_SECONDS = 300;

const freshRef = (product: string, deviceId: string): ArtefactRef =>
  artefactRef("signin-fresh", `${product}:${deviceId}`);

/** Mark a same-device sign-in. A store that cannot be reached leaves no mark: no step-up. */
export async function markFresh(
  env: Env,
  product: string,
  deviceId: string,
): Promise<void> {
  try {
    await putArtefact(
      env,
      freshRef(product, deviceId),
      "1",
      FRESH_SIGNIN_TTL_SECONDS,
    );
  } catch {
    // Fail closed: without the mark the link offer is simply not available.
  }
}

/** True while the device's step-up is live. Reads the mark without spending it (the offer list). */
export async function freshLive(
  env: Env,
  product: string,
  deviceId: string,
): Promise<boolean> {
  return (await getArtefact(env, freshRef(product, deviceId))) !== null;
}

/** Spend the device's step-up. True for exactly one caller per mark; an unreachable store is false. */
export async function spendFresh(
  env: Env,
  product: string,
  deviceId: string,
): Promise<boolean> {
  return (await consumeArtefact(env, freshRef(product, deviceId))) !== null;
}
