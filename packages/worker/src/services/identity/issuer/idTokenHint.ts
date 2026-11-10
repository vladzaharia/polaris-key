/**
 * Verifying an `id_token_hint` (I-21.7; V5 §12.13.3). The hint is an `id_token` THIS issuer signed:
 * RS256 under one of this product's issuer keys, `typ` `JWT`, `iss` this issuer. `exp` is not
 * checked, so an expired hint is accepted (OIDC Core §3.1.2.1). Only its `sub` is used, and only
 * to compare with the signed-in account's subject; nothing else in it is read or trusted.
 *
 * `alg` is pinned before any key is chosen, so `none`, an `HS*` algorithm and `EdDSA` never reach
 * a key. The key set is the product's own (`issuerJwks`), so another product's token fails.
 */

import { compactVerify, createLocalJWKSet, decodeProtectedHeader } from "jose";
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
    if (claims.iss !== issuer) return null;
    return typeof claims.sub === "string" && claims.sub !== ""
      ? claims.sub
      : null;
  } catch {
    return null;
  }
}
