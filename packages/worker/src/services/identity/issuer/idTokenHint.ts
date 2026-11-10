/**
 * Verifying an `id_token_hint` (I-21.7; V5 §12.13.3). The hint is an `id_token` THIS issuer signed:
 * RS256 under one of this product's issuer keys, `typ` `JWT`, `iss` this issuer. `exp` is not
 * checked, so an expired hint is accepted (OIDC Core §3.1.2.1). Only its `sub` is used, and only
 * to compare with the signed-in account's subject; nothing else in it is read or trusted.
 *
 * `alg` is pinned before any key is chosen, so `none`, an `HS*` algorithm and `EdDSA` never reach
 * a key. The key set is the product's own (`issuerJwks`), so another product's token fails. The
 * hint's `aud` must be the REQUESTING client's id: one client cannot probe the signed-in account
 * with a hint another client was issued.
 */

import {
  compactVerify,
  createLocalJWKSet,
  decodeJwt,
  decodeProtectedHeader,
} from "jose";
import { ISSUER_TOKEN_ALG, ID_TOKEN_TYP } from "@polaris-key/protocol/identity";
import type { Db } from "../../../db/types.js";
import { issuerJwks } from "./keys.js";

/** The longest hint read: an `id_token` is a few hundred bytes. */
export const ID_TOKEN_HINT_MAX_LENGTH = 8192;

/** The hint's `sub`, or `null` when it is not a valid `id_token` of this issuer. */
export async function verifyIdTokenHint(
  db: Db,
  product: string,
  issuer: string,
  clientId: string,
  hint: string,
): Promise<string | null> {
  if (hint.length === 0 || hint.length > ID_TOKEN_HINT_MAX_LENGTH) return null;
  try {
    const header = decodeProtectedHeader(hint);
    if (header.alg !== ISSUER_TOKEN_ALG || header.typ !== ID_TOKEN_TYP)
      return null;
    const keys = createLocalJWKSet(await issuerJwks(db, product));
    const { payload } = await compactVerify(hint, keys, {
      algorithms: [ISSUER_TOKEN_ALG],
    });
    const claims = JSON.parse(new TextDecoder().decode(payload)) as Record<
      string,
      unknown
    >;
    if (claims.iss !== issuer || claims.aud !== clientId) return null;
    return typeof claims.sub === "string" && claims.sub !== ""
      ? claims.sub
      : null;
  } catch {
    return null;
  }
}

/**
 * The audience an `id_token_hint` names, read WITHOUT verifying it, so `end-session` can find the
 * client the hint is meant for when the request names none (RP-Initiated Logout 1.0 §2). It
 * chooses nothing but which client's id the verification above is then bound to: the hint is only
 * ever trusted through {@link verifyIdTokenHint}, which pins `alg`, the key set, `iss` and this
 * `aud`. `null` for anything that is not a JWT with one string `aud`.
 */
export function hintAudience(hint: string): string | null {
  if (hint.length === 0 || hint.length > ID_TOKEN_HINT_MAX_LENGTH) return null;
  try {
    const aud = decodeJwt(hint).aud;
    return typeof aud === "string" ? aud : null;
  } catch {
    return null;
  }
}
