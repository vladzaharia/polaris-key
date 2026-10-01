/// <reference types="@cloudflare/workers-types" />

/**
 * Short-lived outlet tokens minted from an opened outlet credential (P5-01).
 *
 *   - `ascToken` — the App Store Connect API JWT: ES256, header `kid` = the key id, claims
 *     `iss` (issuer id), `iat`, `exp` (`exp - iat` = 1200 s, Apple's ceiling) and
 *     `aud: "appstoreconnect-v1"`. Reused from a per-isolate memo until 60 s before it expires.
 *   - `googleAccessToken` — an OAuth access token for a Google service account through the
 *     JWT-bearer grant (RFC 7523): an RS256 assertion posted to Google's token endpoint. Cached in
 *     KV, SEALED under the `outlet-credential` AAD kind (a KV dump yields ciphertext), until
 *     300 s before Google's `expires_in`.
 *   - `readSealedToken` / `writeSealedToken` / `outletTokenSlot` — that sealed cache, exported
 *     so P5-04 caches Microsoft Entra client-credentials tokens the same way.
 *
 * Caching is also what keeps the audit trail small: a connector opens its credential (one
 * `outlet_credential.use` row) only when it has no usable token.
 *
 * Every function is pure given an injected `fetchImpl` and `now`, so the flow is tested against
 * a fake token endpoint with keys generated in the test — no network, no real credential.
 */

import type { Env } from "../env.js";
import { open, seal, type SealContext } from "../keyvault.js";
import { pk } from "../kv.js";
import { signJwtEs256, signJwtRs256 } from "./jwt.js";
import {
  GOOGLE_TOKEN_URI,
  type OpenedOutletCredential,
} from "./outletCredentials.js";

/** A fetch with the platform `fetch` shape, injectable for tests. */
export type FetchImpl = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(s),
  );
  let hex = "";
  for (const b of new Uint8Array(digest))
    hex += b.toString(16).padStart(2, "0");
  return hex;
}

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
 * as a credential or the reverse. `scopeHash` must change whenever the token would (scopes, and
 * the key it was minted with), so a rotated key never serves its predecessor's token.
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

/** Per-isolate memo. An ASC JWT is a self-contained bearer token with no server-side state, so
 *  memory is the right cache: nothing persists it, and an isolate restart only costs a sign. */
const ascMemo = new Map<string, { token: string; exp: number }>();

/**
 * The App Store Connect API token for an `asc-api-key` credential, minted at `now` or reused
 * until 60 s before its expiry. The memo key covers the key material, so rotating the `.p8`
 * (same credential id) never serves a token signed by the old key.
 */
export async function ascToken(
  cred: OpenedOutletCredential<"asc-api-key">,
  now: number,
): Promise<string> {
  const { keyId, issuerId, p8 } = cred.value;
  const memoKey = `${cred.product}:${cred.credentialId}:${await sha256Hex(`${keyId}\n${issuerId}\n${p8}`)}`;
  const hit = ascMemo.get(memoKey);
  if (hit && hit.exp - ASC_REUSE_MARGIN > now) return hit.token;

  const exp = now + ASC_TOKEN_LIFETIME;
  const token = await signJwtEs256(
    { iss: issuerId, iat: now, exp, aud: ASC_AUDIENCE },
    p8,
    keyId,
  );
  if (ascMemo.size >= ASC_MEMO_MAX) ascMemo.clear();
  ascMemo.set(memoKey, { token, exp });
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
 * An OAuth access token for a `google-service-account` credential at `scopes`, from the sealed
 * KV cache or a fresh JWT-bearer exchange. THROWS when the exchange fails; the message carries
 * the HTTP status only, never the response body or anything from the key.
 */
export async function googleAccessToken(
  env: Env,
  cred: OpenedOutletCredential<"google-service-account">,
  scopes: readonly string[],
  now: number,
  fetchImpl: FetchImpl = fetch,
): Promise<string> {
  const scope = [...new Set(scopes)].sort().join(" ");
  if (scope.length === 0) throw new Error("google token: no scopes requested");
  const { client_email, private_key } = cred.value;
  const scopeHash = (
    await sha256Hex(`${scope}\n${client_email}\n${private_key}`)
  ).slice(0, 32);
  const slot = outletTokenSlot(cred.product, cred.credentialId, scopeHash);

  const cached = await readSealedToken(env, slot, now);
  if (cached) return cached.token;

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
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: GOOGLE_JWT_BEARER_GRANT,
      assertion,
    }).toString(),
  });
  if (!res.ok) throw new Error(`google token exchange failed: ${res.status}`);
  let body: { access_token?: unknown; expires_in?: unknown };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new Error("google token exchange returned no JSON");
  }
  if (
    typeof body.access_token !== "string" ||
    body.access_token.length === 0 ||
    typeof body.expires_in !== "number" ||
    !(body.expires_in > 0)
  )
    throw new Error("google token exchange returned no token");

  await writeSealedToken(
    env,
    slot,
    body.access_token,
    body.expires_in - GOOGLE_CACHE_MARGIN,
    now,
  );
  return body.access_token;
}
