/// <reference types="@cloudflare/workers-types" />

// The platform-level device user-code index: normalised user code → the product that issued it.
//
// The per-product index (`device-user`, `services/identity/productOidc/userCode.ts`) answers
// "which flow does this code open, in THIS product". The platform entry pages (`/device`, `/tv`)
// get a code with no product, so this second index answers "which product". It holds nothing
// else: no device code, no flow. Its entry is written with `ifAbsent` when a flow starts, which
// is also what makes a user code unique across live flows platform-wide, lives exactly as long
// as the per-product entry, and is removed with it.
//
// Like the per-product address, the key is the code's peppered hash (R12-04): a listing of the
// store yields nothing a visitor could type. Codes never reach a log from here.

import { hashKey } from "../platform/crypto.js";
import type { Env } from "../platform/env.js";
import {
  artefactRef,
  deleteArtefact,
  getArtefact,
  putArtefact,
  type ArtefactRef,
} from "./singleUse.js";

/** RFC 8628 §6.1's recommended user-code alphabet (20 consonants). */
export const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

export const USER_CODE_LENGTH = 8;

/**
 * What a human typed (or a QR code carried) → the canonical code, or `null` when it cannot be
 * one. Upper-case; spaces and hyphens dropped; anything outside the alphabet, or the wrong
 * length, is invalid — never "corrected", so a lookup only ever happens for a well-formed code.
 */
export function normalizeUserCode(
  raw: string | null | undefined,
): string | null {
  if (!raw || raw.length > 64) return null;
  const code = raw.toUpperCase().replace(/[\s-]/g, "");
  if (code.length !== USER_CODE_LENGTH) return null;
  for (const ch of code) if (!USER_CODE_ALPHABET.includes(ch)) return null;
  return code;
}

/** `WDJBMJHT` → `WDJB-MJHT`, the display (and `userCode` wire) form. */
export function formatUserCode(normalised: string): string {
  return `${normalised.slice(0, 4)}-${normalised.slice(4)}`;
}

/** Store address of the platform index entry for a normalised user code. */
export async function deviceCodeIndexKey(
  env: Env,
  normalisedUserCode: string,
): Promise<ArtefactRef> {
  return artefactRef(
    "device-user-global",
    await hashKey(normalisedUserCode, env.KEY_HASH_PEPPER),
  );
}

/** Claim a code for a product. False when a live flow already holds it (draw another code). */
export async function claimDeviceCode(
  env: Env,
  normalisedUserCode: string,
  product: string,
  ttlSec: number,
): Promise<boolean> {
  return putArtefact(
    env,
    await deviceCodeIndexKey(env, normalisedUserCode),
    product,
    ttlSec,
    { ifAbsent: true },
  );
}

/** The product slug a live code belongs to, or null. */
export async function lookupDeviceCode(
  env: Env,
  normalisedUserCode: string,
): Promise<string | null> {
  return getArtefact(env, await deviceCodeIndexKey(env, normalisedUserCode));
}

/** Release a code, but only if `product` holds it: a flow that predates this index must not
 *  delete another product's live entry for the same code. */
export async function releaseDeviceCode(
  env: Env,
  normalisedUserCode: string,
  product: string,
): Promise<void> {
  const key = await deviceCodeIndexKey(env, normalisedUserCode);
  if ((await getArtefact(env, key)) === product) await deleteArtefact(env, key);
}
