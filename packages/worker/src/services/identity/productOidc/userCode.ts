/// <reference types="@cloudflare/workers-types" />

import { hashKey } from "../../../platform/crypto.js";
import { type Env } from "../../../platform/env.js";
import { randomBytes } from "../../../platform/random.js";
import {
  artefactRef,
  deleteArtefact,
  putArtefact,
  type ArtefactRef,
} from "../../../core/singleUse.js";

import {
  USER_CODE_ALPHABET,
  USER_CODE_LENGTH,
  claimDeviceCode,
  formatUserCode,
  normalizeUserCode,
  releaseDeviceCode,
} from "../../../core/deviceCodeIndex.js";

// The alphabet, the format and the normaliser live in Core: the platform entry pages normalise a
// typed code with no product in hand.
export {
  USER_CODE_ALPHABET,
  USER_CODE_LENGTH,
  formatUserCode,
  normalizeUserCode,
};

/** Retries on an index collision before giving up (a collision among live codes is ~1e-10). */
export const USER_CODE_ATTEMPTS = 5;

/** A fresh user code, normalised (no separator). Rejection sampling keeps it unbiased:
 *  240 is the largest multiple of 20 that fits in a byte. */
export function generateUserCode(): string {
  let out = "";
  while (out.length < USER_CODE_LENGTH) {
    for (const b of randomBytes(USER_CODE_LENGTH * 2)) {
      if (b >= 240) continue;
      out += USER_CODE_ALPHABET[b % USER_CODE_ALPHABET.length];
      if (out.length === USER_CODE_LENGTH) break;
    }
  }
  return out;
}

/**
 * Single-use store address of the user-code index: normalised user code → the flow's
 * `deviceCode`. Written with `ifAbsent`, so two flows can never claim one live user code.
 *
 * R12-04: a user code is a short-lived bearer handle for the confirmation page, so the address
 * is its peppered hash — a listing yields nothing a visitor could type. The value is the
 * device code, which never leaves the server on this path.
 */
export async function deviceUserKey(
  env: Env,
  product: string,
  normalisedUserCode: string,
): Promise<ArtefactRef> {
  return artefactRef(
    "device-user",
    `${product}:${await hashKey(normalisedUserCode, env.KEY_HASH_PEPPER)}`,
  );
}

/** Drop a flow's user-code index. Records written before the independent code existed carry a
 *  prefix-derived code that does not normalise, and never had an index. */
export async function deleteUserCodeIndex(
  env: Env,
  product: string,
  userCode: string,
): Promise<void> {
  const code = normalizeUserCode(userCode);
  if (!code) return;
  await deleteArtefact(env, await deviceUserKey(env, product, code));
  await releaseDeviceCode(env, code, product);
}

/**
 * Claim a fresh user code for a flow: unique among live flows platform-wide (the platform index
 * is written `ifAbsent`) and within the product. Returns the normalised code, or null when every
 * attempt collided. A collision draws a new code; the platform entry is rolled back when the
 * per-product slot is the one that was taken (a flow that predates the platform index).
 */
export async function claimUserCode(
  env: Env,
  product: string,
  deviceCode: string,
  ttlSec: number,
  generate: () => string = generateUserCode,
): Promise<string | null> {
  for (let i = 0; i < USER_CODE_ATTEMPTS; i++) {
    const code = generate();
    if (!(await claimDeviceCode(env, code, product, ttlSec))) continue;
    const claimed = await putArtefact(
      env,
      await deviceUserKey(env, product, code),
      deviceCode,
      ttlSec,
      { ifAbsent: true },
    );
    if (claimed) return code;
    await releaseDeviceCode(env, code, product);
  }
  return null;
}
