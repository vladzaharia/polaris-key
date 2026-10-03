/// <reference types="@cloudflare/workers-types" />

/**
 * Short-lived outlet tokens minted from an outlet credential (P5-01).
 *
 *   - `ascToken` — the App Store Connect API JWT: ES256, header `kid` = the key id, claims
 *     `iss` (issuer id), `iat`, `exp` (`exp - iat` = 1200 s, Apple's ceiling) and
 *     `aud: "appstoreconnect-v1"`. Reused from a per-isolate memo until 60 s before it expires.
 *   - `googleAccessToken` — an OAuth access token for a Google service account through the
 *     JWT-bearer grant (RFC 7523): an RS256 assertion posted to Google's token endpoint. Cached in
 *     KV, SEALED under the `outlet-credential` AAD kind (a KV dump yields ciphertext), until
 *     300 s before Google's `expires_in`. The exchange sends `redirect: "manual"` (any 3xx is a
 *     failure, so the assertion is never re-posted elsewhere) and reads at most
 *     `MAX_GOOGLE_TOKEN_RESPONSE_BYTES` of the answer.
 *   - `readSealedToken` / `writeSealedToken` / `outletTokenSlot` / `outletTokenSlotHash` — that
 *     sealed cache, exported so P5-04 caches Microsoft Entra client-credentials tokens the same
 *     way (check by `outletCredentialVersion`, open only on a miss).
 *
 * **Cache first, open on a miss.** Both token functions take a credential id, not an opened
 * credential. They key their cache by the credential's non-secret version marker
 * (`outletCredentialVersion`: a hash of the sealed blob, read without decrypting), so a hit
 * returns the token with no `openOutletCredential` call — no decryption, no
 * `outlet_credential.use` audit row, no `last_used_at` write. Only a miss opens (and audits) the
 * credential. That is what keeps the audit trail to tens of rows a day per credential. A rotated
 * value has a new marker, so it never serves its predecessor's token.
 *
 * Because a hit hands out a store bearer token without an audited open, this module is itself a
 * custody boundary: `test/outletCredentialReach.test.ts` lets only the Distribution service
 * import it.
 *
 * Every function is pure given an injected `fetchImpl` and `now`, so the flow is tested against
 * a fake token endpoint with keys generated in the test — no network, no real credential.
 */

import type { Env } from "../env.js";
import type { Db } from "../db/types.js";
import { sha256Hex } from "../crypto.js";
import { open, seal, type SealContext } from "../keyvault.js";
import { pk } from "../kv.js";
import { signJwtEs256, signJwtRs256 } from "./jwt.js";
import { isRedirect, readCappedText } from "./readCapped.js";
import {
  GOOGLE_TOKEN_URI,
  openOutletCredential,
  outletCredentialVersion,
} from "./outletCredentials.js";

/** A fetch with the platform `fetch` shape, injectable for tests. */
export type FetchImpl = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

// ── the sealed token cache ───────────────────────────────────────────────────────────────────

/** Where a cached outlet token lives in KV, and the AAD slot it is sealed under. */
export interface SealedTokenSlot {
  key: string;
  ctx: SealContext;
}

/** A cached token: `expiresAt` is when the CACHE stops serving it, already short of the
 *  issuer's own expiry by the caller's safety margin. */
export interface CachedOutletToken {
  token: string;
  expiresAt: number;
}

/**
 * The slot for one credential's token at one scope. The AAD is
 * `pkey:v2:<product>:outlet-credential:token:<credential_id>:<scope hash>` — the `token:` prefix
 * cannot collide with a credential id (ids have no `:`), so a cached token can never be opened
 * as a credential or the reverse. `scopeHash` must change whenever the token would — use
 * `outletTokenSlotHash(scope, version)` so a rotated credential never serves its predecessor's
 * token, and so the slot can be computed WITHOUT opening the credential.
 */
export function outletTokenSlot(
  product: string,
  credentialId: string,
  scopeHash: string,
): SealedTokenSlot {
  const id = `token:${credentialId}:${scopeHash}`;
  return {
    key: pk(product, "outlet-token", `${credentialId}:${scopeHash}`),
    ctx: { product, kind: "outlet-credential", id },
  };
}

/** The `scopeHash` for `outletTokenSlot`: the requested scope string and the credential's
 *  non-secret version marker (`outletCredentialVersion`), hashed. Never the key material — the
 *  slot must be computable before (and without) an open. */
export async function outletTokenSlotHash(
  scope: string,
  version: string,
): Promise<string> {
  return (await sha256Hex(`${scope}\n${version}`)).slice(0, 32);
}

/** A cached token that is still good at `now`, or null. A blob that will not open (rotated KEK,
 *  tampered, wrong slot) is a miss, never an error. */
export async function readSealedToken(
  env: Env,
  slot: SealedTokenSlot,
  now: number,
): Promise<CachedOutletToken | null> {
  const raw = await env.HOT.get(slot.key);
  if (!raw) return null;
  try {
    const rec = JSON.parse(await open(env, raw, slot.ctx)) as CachedOutletToken;
    if (
      typeof rec.token === "string" &&
      rec.token.length > 0 &&
      typeof rec.expiresAt === "number" &&
      rec.expiresAt > now
    )
      return rec;
  } catch {
    /* a miss */
  }
  return null;
}

/** KV refuses an `expirationTtl` under 60 s. */
const KV_MIN_TTL = 60;

/** Seal and cache a token for `ttlSeconds` (its `expiresAt` is `now + ttlSeconds`). A TTL under
 *  KV's minimum, or a seal/KV failure, caches nothing — an extra round trip is the right price,
 *  a plaintext bearer token in KV is not. */
export async function writeSealedToken(
  env: Env,
  slot: SealedTokenSlot,
  token: string,
  ttlSeconds: number,
  now: number,
): Promise<void> {
  if (!(ttlSeconds >= KV_MIN_TTL)) return;
  const rec: CachedOutletToken = { token, expiresAt: now + ttlSeconds };
  try {
    await env.HOT.put(
      slot.key,
      await seal(env, JSON.stringify(rec), slot.ctx),
      {
        expirationTtl: Math.floor(ttlSeconds),
      },
    );
  } catch {
    /* serve uncached */
  }
}

// ── App Store Connect ────────────────────────────────────────────────────────────────────────

/** Apple's ceiling on an App Store Connect API token's lifetime. */
export const ASC_TOKEN_LIFETIME = 20 * 60;
export const ASC_AUDIENCE = "appstoreconnect-v1";
/** A memoised token is not handed out within this many seconds of its expiry. */
const ASC_REUSE_MARGIN = 60;
const ASC_MEMO_MAX = 256;

/** Per-isolate memo, keyed by product, credential id and version marker. An ASC JWT is a
 *  self-contained bearer token with no server-side state, so memory is the right cache: nothing
 *  persists it, and an isolate restart only costs one open and a sign. */
const ascMemo = new Map<string, { token: string; exp: number }>();

/**
 * The App Store Connect API token for the `asc-api-key` credential `credentialId`, reused from
 * the memo until 60 s before its expiry, otherwise minted at `now` from a fresh open (audited
 * under `use`, e.g. `asc:poll`). `null` — "unusable credential" — when the credential is
 * unknown, disabled, of another kind, or will not open. A memo hit never opens the credential.
 */
export async function ascToken(
  env: Env,
  db: Db,
  product: string,
  credentialId: string,
  use: string,
  now: number,
): Promise<string | null> {
  const version = await outletCredentialVersion(
    db,
    product,
    credentialId,
    "asc-api-key",
  );
  if (version === null) return null;
  const hit = ascMemo.get(`${product}:${credentialId}:${version}`);
  if (hit && hit.exp - ASC_REUSE_MARGIN > now) return hit.token;

  const cred = await openOutletCredential(env, db, product, credentialId, use, {
    kind: "asc-api-key",
    now,
  });
  if (!cred) return null;
  const { keyId, issuerId, p8 } = cred.value;
  const exp = now + ASC_TOKEN_LIFETIME;
  const token = await signJwtEs256(
    { iss: issuerId, iat: now, exp, aud: ASC_AUDIENCE },
    p8,
    keyId,
  );
  if (ascMemo.size >= ASC_MEMO_MAX) ascMemo.clear();
  // Keyed by the version of the blob actually opened: a rotation between the version read and
  // the open caches under the new marker, never the old.
  ascMemo.set(`${product}:${credentialId}:${cred.version}`, { token, exp });
  return token;
}

// ── Google (JWT-bearer) ──────────────────────────────────────────────────────────────────────

export const GOOGLE_JWT_BEARER_GRANT =
  "urn:ietf:params:oauth:grant-type:jwt-bearer";
/** The assertion's own lifetime; Google caps it at one hour. */
const GOOGLE_ASSERTION_LIFETIME = 60 * 60;
/** The cache stops serving a token this long before Google says it expires. */
const GOOGLE_CACHE_MARGIN = 300;
/**
 * The most of a Google token response read. One is `{access_token, expires_in, token_type}` —
 * an access token of ~200 B to ~2 KiB — so 64 KiB (the Entra exchange's cap) is generous while
 * bounding what a misbehaving endpoint could make the isolate buffer.
 */
export const MAX_GOOGLE_TOKEN_RESPONSE_BYTES = 64 * 1024;

/**
 * An OAuth access token for the `google-service-account` credential `credentialId` at `scopes`:
 * from the sealed KV cache when it holds one for this credential version and scope, otherwise
 * from a fresh open (audited under `use`, e.g. `play:token`) and JWT-bearer exchange.
 *
 * `null` — "unusable credential" — when the credential is unknown, disabled, of another kind or
 * will not open. THROWS when the exchange fails; the message carries the HTTP status only, never
 * the response body or anything from the key. A cache hit never opens the credential.
 */
export async function googleAccessToken(
  env: Env,
  db: Db,
  product: string,
  credentialId: string,
  scopes: readonly string[],
  use: string,
  now: number,
  fetchImpl: FetchImpl = fetch,
): Promise<string | null> {
  const scope = [...new Set(scopes)].sort().join(" ");
  if (scope.length === 0) throw new Error("google token: no scopes requested");
  const version = await outletCredentialVersion(
    db,
    product,
    credentialId,
    "google-service-account",
  );
  if (version === null) return null;
  const cached = await readSealedToken(
    env,
    outletTokenSlot(
      product,
      credentialId,
      await outletTokenSlotHash(scope, version),
    ),
    now,
  );
  if (cached) return cached.token;

  const cred = await openOutletCredential(env, db, product, credentialId, use, {
    kind: "google-service-account",
    now,
  });
  if (!cred) return null;
  const { client_email, private_key } = cred.value;
  const assertion = await signJwtRs256(
    {
      iss: client_email,
      scope,
      aud: GOOGLE_TOKEN_URI,
      iat: now,
      exp: now + GOOGLE_ASSERTION_LIFETIME,
    },
    private_key,
  );
  const res = await fetchImpl(GOOGLE_TOKEN_URI, {
    method: "POST",
    // Never follow a redirect with the signed assertion in the body.
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: GOOGLE_JWT_BEARER_GRANT,
      assertion,
    }).toString(),
  });
  if (!res.ok || isRedirect(res)) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`google token exchange failed: ${res.status}`);
  }
  let body: { access_token?: unknown; expires_in?: unknown };
  try {
    body = JSON.parse(
      await readCappedText(
        res,
        MAX_GOOGLE_TOKEN_RESPONSE_BYTES,
        () => new Error("too large"),
      ),
    ) as typeof body;
  } catch {
    throw new Error("google token exchange returned no JSON");
  }
  // `null`, an array or a scalar is "no token", not a TypeError on the property reads below.
  if (!body || typeof body !== "object" || Array.isArray(body)) body = {};
  if (
    typeof body.access_token !== "string" ||
    body.access_token.length === 0 ||
    typeof body.expires_in !== "number" ||
    !(body.expires_in > 0)
  )
    throw new Error("google token exchange returned no token");

  await writeSealedToken(
    env,
    outletTokenSlot(
      product,
      credentialId,
      await outletTokenSlotHash(scope, cred.version),
    ),
    body.access_token,
    body.expires_in - GOOGLE_CACHE_MARGIN,
    now,
  );
  return body.access_token;
}
