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
 * The link route (I-43.2) reads and spends the mark; it adds those two operations beside `markFresh`.
 */

import type { Env } from "../../../platform/env.js";
import {
  artefactRef,
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
