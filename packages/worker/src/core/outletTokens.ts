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
import { sha256Hex } from "../platform/hash.js";
import { open, seal, type SealContext } from "../keyvault.js";
import { pk } from "../kv.js";
import { signJwtEs256, signJwtRs256 } from "./jwt.js";
import { isRedirect, readCappedText } from "./readCapped.js";
import {
  GOOGLE_TOKEN_URI,
  openOutletCredential,
  outletCredentialVersion,
  type TransientOutletCredential,
} from "./outletCredentials.js";
import {
  openPlatformCredential,
  parsePlatformCredentialHandle,
  PLATFORM_SEAL_PRODUCT,
  platformPin,
  resolvePlatformCredential,
  type PlatformCredentialId,
  type PlatformOpenPurpose,
} from "./platformCredentials.js";

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

// ── token exchange errors ───────────────────────────────────────────────────────────────────

/**
 * A refused OAuth token exchange (Google's JWT-bearer grant, Microsoft Entra's client
 * credentials). The message is the status line it always was; `code` is the endpoint's `error`
 * token (`invalid_grant`, `invalid_client`, `unauthorized_client`, …) and `subCode` Entra's first
 * `error_codes` number (`7000222`: the client secret expired), both read from the error body so
 * the live credential check (UX-69) can say WHY. Never the `error_description` free text, never
 * anything from the credential.
 */
export class TokenExchangeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: { error: string | null; subCode: number | null } | null,
  ) {
    super(message);
    this.name = "TokenExchangeError";
  }
}

const OAUTH_ERROR = /^[a-z][a-z0-9_]{0,63}$/;

/** The `error` token and Entra's first `error_codes` entry of an OAuth error body, or null.
 *  Reads at most 64 KiB; never throws; never keeps the body. */
export async function oauthErrorCode(
  res: Response,
): Promise<{ error: string | null; subCode: number | null } | null> {
  try {
    const parsed = JSON.parse(
      await readCappedText(res, 64 * 1024, () => new Error("too large")),
    ) as { error?: unknown; error_codes?: unknown };
    if (!parsed || typeof parsed !== "object") return null;
    const error =
      typeof parsed.error === "string" && OAUTH_ERROR.test(parsed.error)
        ? parsed.error
        : null;
    const first = Array.isArray(parsed.error_codes)
      ? parsed.error_codes[0]
      : null;
    const subCode =
      typeof first === "number" && Number.isInteger(first) && first > 0
        ? first
        : null;
    return error === null && subCode === null ? null : { error, subCode };
  } catch {
    await res.body?.cancel().catch(() => undefined);
    return null;
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

// ── App Store Server API (P6-01) ────────────────────────────────────────────────────────────

/** The App Store Server API token's lifetime: Apple caps it at 60 minutes; 20 minutes, as for
 *  App Store Connect, keeps a leaked token short-lived. */
export const APP_STORE_SERVER_TOKEN_LIFETIME = 20 * 60;
const appStoreMemo = new Map<string, { token: string; exp: number }>();

/**
 * The App Store Server API bearer token for the `app-store-server-key` credential `credentialId`
 * (P6-01): ES256, header `kid` = the key id and `typ: JWT`, claims `iss` (issuer id), `iat`,
 * `exp` (20 minutes), `aud: "appstoreconnect-v1"` and `bid` (the bundle id — the caller has
 * already checked it equals the credential's pin). Memoised per isolate like `ascToken`; `null`
 * for an unusable credential. A memo hit never opens the credential.
 */
export async function appStoreServerToken(
  env: Env,
  db: Db,
  product: string,
  credentialId: string,
  bundleId: string,
  use: string,
  now: number,
): Promise<string | null> {
  const version = await outletCredentialVersion(
    db,
    product,
    credentialId,
    "app-store-server-key",
  );
  if (version === null) return null;
  const hit = appStoreMemo.get(
    `${product}:${credentialId}:${version}:${bundleId}`,
  );
  if (hit && hit.exp - ASC_REUSE_MARGIN > now) return hit.token;
  const cred = await openOutletCredential(env, db, product, credentialId, use, {
    kind: "app-store-server-key",
    now,
  });
  if (!cred) return null;
  const { keyId, issuerId, p8 } = cred.value;
  const exp = now + APP_STORE_SERVER_TOKEN_LIFETIME;
  const token = await signJwtEs256(
    { iss: issuerId, iat: now, exp, aud: ASC_AUDIENCE, bid: bundleId },
    p8,
    keyId,
  );
  if (appStoreMemo.size >= ASC_MEMO_MAX) appStoreMemo.clear();
  appStoreMemo.set(`${product}:${credentialId}:${cred.version}:${bundleId}`, {
    token,
    exp,
  });
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
  const { token, ttl } = await googleTokenExchange(
    cred.value,
    scope,
    now,
    fetchImpl,
  );
  await writeSealedToken(
    env,
    outletTokenSlot(
      product,
      credentialId,
      await outletTokenSlotHash(scope, cred.version),
    ),
    token,
    ttl,
    now,
  );
  return token;
}

/**
 * The JWT-bearer exchange itself: an RS256 assertion for `scope`, posted to Google's one token
 * endpoint with `redirect: "manual"`, the answer read through `readCappedText`. Answers the
 * access token and how long it may be cached. THROWS on a failed exchange with a status line
 * only — never the response body or anything from the key.
 */
async function googleTokenExchange(
  value: { client_email: string; private_key: string },
  scope: string,
  now: number,
  fetchImpl: FetchImpl,
): Promise<{ token: string; ttl: number }> {
  const assertion = await signJwtRs256(
    {
      iss: value.client_email,
      scope,
      aud: GOOGLE_TOKEN_URI,
      iat: now,
      exp: now + GOOGLE_ASSERTION_LIFETIME,
    },
    value.private_key,
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
    const code = isRedirect(res) ? null : await oauthErrorCode(res);
    if (isRedirect(res)) await res.body?.cancel().catch(() => undefined);
    throw new TokenExchangeError(
      `google token exchange failed: ${res.status}`,
      res.status,
      code,
    );
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
  return {
    token: body.access_token,
    ttl: body.expires_in - GOOGLE_CACHE_MARGIN,
  };
}

// ── platform (team-level) credentials (A-16) ────────────────────────────────────────────────

/**
 * Whether `purpose` may use platform credential `id` at all, checked BEFORE any memo or cache: a
 * cached team token is the same bearer for every product, so the per-product pin must gate the
 * lookup itself — a memo hit must never stand in for the pin. A team purpose (no product) has no
 * pin; the caller is the platform admin surface.
 */
async function platformPurposeAllowed(
  db: Db,
  id: PlatformCredentialId,
  purpose: PlatformOpenPurpose,
): Promise<boolean> {
  if (!("product" in purpose)) return true;
  return (await platformPin(db, id, purpose.product)) === purpose.pin;
}

/**
 * The App Store Connect API token minted from the PLATFORM team key (`app-store.api-key`), for a
 * product acting on its pinned app (`{product, pin: appleId}`) or a team-wide read (`{team}`).
 * `null` when no platform key is usable or the product's pin is not `appleId`. Memoised per
 * isolate by source and version like `ascToken`; only a miss opens (and audits) the key.
 */
export async function platformAscToken(
  env: Env,
  db: Db,
  purpose: PlatformOpenPurpose,
  use: string,
  now: number,
): Promise<string | null> {
  const id = "app-store.api-key";
  if (!(await platformPurposeAllowed(db, id, purpose))) return null;
  const ref = await resolvePlatformCredential(env, db, id);
  if (!ref) return null;
  const hit = ascMemo.get(`platform:${id}:${ref.version}`);
  if (hit && hit.exp - ASC_REUSE_MARGIN > now) return hit.token;
  const cred = await openPlatformCredential(env, db, id, use, purpose, now);
  if (!cred) return null;
  const { keyId, issuerId, p8 } = cred.value;
  const exp = now + ASC_TOKEN_LIFETIME;
  const token = await signJwtEs256(
    { iss: issuerId, iat: now, exp, aud: ASC_AUDIENCE },
    p8,
    keyId,
  );
  if (ascMemo.size >= ASC_MEMO_MAX) ascMemo.clear();
  ascMemo.set(`platform:${id}:${cred.version}`, { token, exp });
  return token;
}

/**
 * The App Store Server API token minted from the PLATFORM In-App Purchase key
 * (`app-store.in-app-purchase-key`) for `product`, whose platform pin must be `bundleId` (the
 * token's `bid`). `null` otherwise, or when no platform key is usable.
 */
export async function platformAppStoreServerToken(
  env: Env,
  db: Db,
  product: string,
  bundleId: string,
  use: string,
  now: number,
): Promise<string | null> {
  const id = "app-store.in-app-purchase-key";
  const purpose = { product, pin: bundleId };
  if (!(await platformPurposeAllowed(db, id, purpose))) return null;
  const ref = await resolvePlatformCredential(env, db, id);
  if (!ref) return null;
  const memoKey = `platform:${id}:${ref.version}:${bundleId}`;
  const hit = appStoreMemo.get(memoKey);
  if (hit && hit.exp - ASC_REUSE_MARGIN > now) return hit.token;
  const cred = await openPlatformCredential(env, db, id, use, purpose, now);
  if (!cred) return null;
  const { keyId, issuerId, p8 } = cred.value;
  const exp = now + APP_STORE_SERVER_TOKEN_LIFETIME;
  const token = await signJwtEs256(
    { iss: issuerId, iat: now, exp, aud: ASC_AUDIENCE, bid: bundleId },
    p8,
    keyId,
  );
  if (appStoreMemo.size >= ASC_MEMO_MAX) appStoreMemo.clear();
  appStoreMemo.set(`platform:${id}:${cred.version}:${bundleId}`, {
    token,
    exp,
  });
  return token;
}

/**
 * A Google OAuth access token minted from the PLATFORM service account
 * (`google-play.service-account`) at `scopes`, for a product acting on its pinned package
 * (`{product, pin: packageName}`) or a team-wide read (`{team}`). The pin is checked before the
 * sealed KV cache (slot under `_platform`, keyed by scope and credential version); only a miss
 * opens (and audits) the key. `null` when unusable; THROWS on a failed exchange (status only).
 */
export async function platformGoogleAccessToken(
  env: Env,
  db: Db,
  purpose: PlatformOpenPurpose,
  scopes: readonly string[],
  use: string,
  now: number,
  fetchImpl: FetchImpl = fetch,
): Promise<string | null> {
  const id = "google-play.service-account";
  const scope = [...new Set(scopes)].sort().join(" ");
  if (scope.length === 0) throw new Error("google token: no scopes requested");
  if (!(await platformPurposeAllowed(db, id, purpose))) return null;
  const ref = await resolvePlatformCredential(env, db, id);
  if (!ref) return null;
  const slotFor = async (version: string) =>
    outletTokenSlot(
      PLATFORM_SEAL_PRODUCT,
      id,
      await outletTokenSlotHash(scope, version),
    );
  const cached = await readSealedToken(env, await slotFor(ref.version), now);
  if (cached) return cached.token;
  const cred = await openPlatformCredential(env, db, id, use, purpose, now);
  if (!cred) return null;
  const { token, ttl } = await googleTokenExchange(
    cred.value,
    scope,
    now,
    fetchImpl,
  );
  await writeSealedToken(env, await slotFor(cred.version), token, ttl, now);
  return token;
}

/**
 * A Google access token for a credential id OR a platform handle (`platform:<id>`, A-16): the
 * product's own `google-service-account` through `googleAccessToken`, the platform service account
 * through `platformGoogleAccessToken` with `pin` (the package acted on) as the product's required
 * pin. One entry point for callers that hold a setup's `credentialId`.
 */
export async function googleAccessTokenFor(
  env: Env,
  db: Db,
  product: string,
  credentialId: string,
  pin: string,
  scopes: readonly string[],
  use: string,
  now: number,
  fetchImpl: FetchImpl = fetch,
): Promise<string | null> {
  return parsePlatformCredentialHandle(credentialId)
    ? platformGoogleAccessToken(
        env,
        db,
        { product, pin },
        scopes,
        use,
        now,
        fetchImpl,
      )
    : googleAccessToken(
        env,
        db,
        product,
        credentialId,
        scopes,
        use,
        now,
        fetchImpl,
      );
}

// ── transient credentials (UX-69, SETUP.md D42) ─────────────────────────────────────────────

/**
 * The App Store Connect API token for an UNSAVED key (`TransientOutletCredential`), for the live
 * check a connect form runs before anything is stored. Minted at `now` with Apple's 20-minute
 * lifetime and NEVER memoised: the key is not stored, so neither is anything derived from it.
 */
export async function transientAscToken(
  cred: TransientOutletCredential<"asc-api-key">,
  now: number,
): Promise<string> {
  const { keyId, issuerId, p8 } = cred.reveal();
  return signJwtEs256(
    {
      iss: issuerId,
      iat: now,
      exp: now + ASC_TOKEN_LIFETIME,
      aud: ASC_AUDIENCE,
    },
    p8,
    keyId,
  );
}

/**
 * A Google access token for an UNSAVED service-account key at `scopes`: the same JWT-bearer
 * exchange as a stored key (one host, `redirect: "manual"`, capped body), never cached. THROWS a
 * `TokenExchangeError` when Google refuses (status and `error` token only).
 */
export async function transientGoogleAccessToken(
  cred: TransientOutletCredential<"google-service-account">,
  scopes: readonly string[],
  now: number,
  fetchImpl: FetchImpl = fetch,
): Promise<string> {
  const scope = [...new Set(scopes)].sort().join(" ");
  if (scope.length === 0) throw new Error("google token: no scopes requested");
  return (await googleTokenExchange(cred.reveal(), scope, now, fetchImpl))
    .token;
}
