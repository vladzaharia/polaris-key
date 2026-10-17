/**
 * The authorization code of `authorize` (WIRE-CONTRACT-V4 §12.4, §12.5; plans/I-08.md §3).
 *
 * Continue issues it, `token` redeems it. It is a `signin-code` artefact in I-02's atomic store:
 *
 *   address   the product and the peppered hash of the code, so a listing of the store yields
 *             nothing that can be presented.
 *   lifetime  60 seconds.
 *   proof     the hash of the PKCE `code_challenge`. `token` hashes the challenge it derives from
 *             the verifier and the store compares in constant time; a match consumes the code and
 *             a mismatch (`maxAttempts` 1) destroys it, so a wrong verifier ends the code and the
 *             verifier cannot be brute-forced. A second redemption finds nothing.
 *   holds     the product, client id, redirect URI, account, pairwise subject, granted scope, the
 *             licence the person chose and the request's `nonce` and licence-choice mode. No
 *             credential: the device is unknown until `token`, and binds there.
 */

import {
  AUTHORIZATION_CODE_TTL_SECONDS,
  type AuthorizeLicenseChoice,
} from "@polaris-key/protocol/identity";
import { hashKey } from "../../../platform/crypto.js";
import { randomToken } from "../../../platform/random.js";
import type { Env } from "../../../platform/env.js";
import {
  artefactRef,
  putArtefact,
  redeemArtefact,
  type ArtefactRef,
} from "../../../core/singleUse.js";

export interface SignInCodeRecord {
  product: string;
  clientId: string;
  redirectUri: string;
  accountId: string;
  /** The account's pairwise subject for the product (`subjectFor`). */
  subject: string;
  scope: string[];
  /** The licence the person chose at Continue (I-08b adds the other answers); `null`: none offered. */
  choice: { licenseId: string } | null;
  nonce: string | null;
  licenseChoice: AuthorizeLicenseChoice;
}

async function codeRef(
  env: Env,
  product: string,
  code: string,
): Promise<ArtefactRef> {
  return artefactRef(
    "signin-code",
    `${product}:${await hashKey(code, env.KEY_HASH_PEPPER)}`,
  );
}

/** A fresh code: 32 random bytes, base64url. */
export function mintAuthorizationCode(): string {
  return randomToken(32);
}

/** Store `record` under a new code bound to `codeChallenge`, and return the code. */
export async function issueAuthorizationCode(
  env: Env,
  record: SignInCodeRecord,
  codeChallenge: string,
): Promise<string> {
  const code = mintAuthorizationCode();
  await putArtefact(
    env,
    await codeRef(env, record.product, code),
    JSON.stringify(record),
    AUTHORIZATION_CODE_TTL_SECONDS,
    { proof: await hashKey(codeChallenge), maxAttempts: 1 },
  );
  return code;
}

/**
 * Redeem `code` with the challenge derived from the presented verifier. The record, or `null` for
 * an unknown, expired, used or mismatching code (every "no" looks the same).
 */
export async function redeemAuthorizationCode(
  env: Env,
  product: string,
  code: string,
  derivedChallenge: string,
): Promise<SignInCodeRecord | null> {
  const out = await redeemArtefact(
    env,
    await codeRef(env, product, code),
    await hashKey(derivedChallenge),
  );
  if (!out.ok) return null;
  try {
    const record = JSON.parse(out.payload) as SignInCodeRecord;
    return typeof record?.product === "string" ? record : null;
  } catch {
    return null;
  }
}
