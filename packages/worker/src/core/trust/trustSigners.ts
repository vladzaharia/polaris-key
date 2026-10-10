/**
 * Which key signs a served trust manifest or a minted bundle.
 *
 * The default is the product's active key. A client that pinned only an OLDER key cannot
 * verify an active-key manifest, so rotation would blind it; `?signer=<kid>` lets it ask for
 * the same manifest signed by a key it does pin. Only active, staged and retired keys may sign:
 * a revoked key is terminal, and signing with it again would undo the revocation.
 */

/// <reference types="@cloudflare/workers-types" />
import type { Db } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import { open } from "../../platform/keyvault.js";
import { listVerificationProductKeys } from "../repo.js";

export interface TrustSigner {
  kid: string;
  pem: string;
}

/** Unsealing costs a KEK operation; keep the opened key for 60 s, keyed by the sealed blob
 *  so a changed row never reuses a stale key. Status is re-read from the DB on every call. */
const MEMO_MS = 60_000;
const memo = new Map<string, { pem: string; at: number }>();

/**
 * The signer for `kid`, or `null` when the product has no such key, the key is revoked (or
 * otherwise not live), or its sealed private half does not open.
 */
export async function loadTrustSigner(
  env: Env,
  db: Db,
  product: string,
  kid: string,
): Promise<TrustSigner | null> {
  const rows = await listVerificationProductKeys(db, product);
  const row = rows.find((r) => r.kid === kid);
  if (!row) return null;
  const memoKey = `${product}\0${kid}\0${row.enc_private_json}`;
  const hit = memo.get(memoKey);
  const t = Date.now();
  if (hit && t - hit.at < MEMO_MS) return { kid, pem: hit.pem };
  try {
    const pem = await open(env, row.enc_private_json, {
      product,
      kind: "signing-key",
      id: kid,
    });
    memo.set(memoKey, { pem, at: t });
    return { kid, pem };
  } catch {
    return null;
  }
}
