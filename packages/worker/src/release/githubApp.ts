/// <reference types="@cloudflare/workers-types" />

/**
 * GitHub App authentication for the release engine.
 *
 * We mint a short-lived App JWT (ES256, signed with the App's PEM private key via
 * WebCrypto — no node:* crypto) then exchange it for an **installation token** scoped
 * to one installation. Installation tokens are cached in KV (product-scoped) so the
 * common path is a single KV read, not two GitHub round-trips per request.
 *
 * Everything here is pure given an injected `fetchImpl`, so the whole flow is testable
 * with no network. The only ambient dependency is WebCrypto, which workerd provides.
 */

import { type Env, secret } from "../env.js";
import { pk } from "../kv.js";

const GITHUB_API = "https://api.github.com";
const USER_AGENT = "polaris-key-release";
/** Installation tokens live ~60m; cache for 55m to leave headroom. */
const TOKEN_TTL_SECONDS = 55 * 60;

/** A fetch with the same shape as the platform `fetch`, injectable for tests. */
export type FetchImpl = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const b64urlStr = (s: string): string => b64url(new TextEncoder().encode(s));

function toAB(b: Uint8Array): ArrayBuffer {
  return b.buffer.slice(
    b.byteOffset,
    b.byteOffset + b.byteLength,
  ) as ArrayBuffer;
}

/** Strip PEM armor + whitespace and decode the base64 body to raw DER bytes. */
function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * GitHub App private keys are distributed as RSA PKCS#1 (`BEGIN RSA PRIVATE KEY`).
 * WebCrypto only imports PKCS#8, so wrap PKCS#1 DER in the PKCS#8 PrivateKeyInfo
 * envelope (the fixed rsaEncryption AlgorithmIdentifier prefix) when needed.
 */
function toPkcs8(pem: string): ArrayBuffer {
  const der = pemToDer(pem);
  if (/BEGIN PRIVATE KEY/.test(pem)) return toAB(der);

  // PKCS#8 = SEQUENCE { version 0, AlgorithmIdentifier rsaEncryption NULL, OCTET STRING pkcs1 }
  const rsaOid = [
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01,
    0x01, 0x05, 0x00,
  ];
  const version = [0x02, 0x01, 0x00];
  const octetHeader = derLen(0x04, der.length);
  const inner = [...version, ...rsaOid, ...octetHeader, ...der];
  const seq = [...derLen(0x30, inner.length), ...inner];
  return toAB(Uint8Array.from(seq));
}

/** Build a DER tag+length prefix (definite form) for a body of `n` bytes. */
function derLen(tag: number, n: number): number[] {
  if (n < 0x80) return [tag, n];
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v >>= 8;
  }
  return [tag, 0x80 | bytes.length, ...bytes];
}

/** Sign a JWT with RS256 (GitHub App JWTs are RS256). */
async function signAppJwt(
  appId: string,
  pem: string,
  now: number,
): Promise<string> {
  const header = { alg: "RS256", typ: "JWT" };
  // 30s clock-skew backdate; 9-minute window (GitHub caps App JWTs at 10m).
  const payload = { iat: now - 30, exp: now + 9 * 60, iss: appId };
  const signingInput = `${b64urlStr(JSON.stringify(header))}.${b64urlStr(JSON.stringify(payload))}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    toPkcs8(pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    toAB(new TextEncoder().encode(signingInput)),
  );
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

const githubHeaders = (auth: string): Record<string, string> => ({
  Accept: "application/vnd.github+json",
  Authorization: auth,
  "User-Agent": USER_AGENT,
  "X-GitHub-Api-Version": "2022-11-28",
});

/** Mint a fresh App JWT from the configured App credentials (throws if unconfigured). */
async function appJwt(env: Env, now: number): Promise<string> {
  const appId = secret(env, "GITHUB_APP_ID");
  const pem = secret(env, "GITHUB_APP_PRIVATE_KEY");
  if (!appId || !pem) throw new Error("github app not configured");
  return signAppJwt(appId, pem, now);
}

/**
 * Resolve the installation id for `owner/repo`. Authenticates as the App (App JWT) and asks
 * `GET /repos/{owner}/{repo}/installation`, which returns the installation that has the App
 * installed on that repo. Throws if the App isn't installed there (so link-repo can surface
 * actionable install guidance to the operator).
 */
export async function discoverInstallation(
  env: Env,
  owner: string,
  repo: string,
  now: number,
  fetchImpl: FetchImpl = fetch,
): Promise<number> {
  const jwt = await appJwt(env, now);
  const res = await fetchImpl(
    `${GITHUB_API}/repos/${owner}/${repo}/installation`,
    {
      headers: githubHeaders(`Bearer ${jwt}`),
    },
  );
  if (res.status === 404)
    throw new Error("github app is not installed on this repository");
  if (!res.ok) throw new Error(`installation discovery failed: ${res.status}`);
  const body = (await res.json()) as { id?: number };
  if (typeof body.id !== "number")
    throw new Error("installation discovery: missing id");
  return body.id;
}

/**
 * GitHub's secondary rate limit answers 403/429 with a `Retry-After` (seconds) or an
 * `X-RateLimit-Reset` epoch; primary exhaustion sets `X-RateLimit-Remaining: 0`. Compute a
 * bounded backoff (capped + small jitter) so a single retry is polite but never stalls a
 * request for long.
 */
function backoffMillis(res: Response): number {
  const retryAfter = res.headers.get("Retry-After");
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0)
      return Math.min(secs, 5) * 1000 + jitter();
  }
  const reset = res.headers.get("X-RateLimit-Reset");
  if (reset) {
    const resetMs = Number(reset) * 1000 - Date.now();
    if (Number.isFinite(resetMs) && resetMs > 0)
      return Math.min(resetMs, 5000) + jitter();
  }
  return 500 + jitter();
}

const jitter = (): number => Math.floor(Math.random() * 250);

/** True when a response is a GitHub rate-limit signal (429, or 403 with remaining=0). */
function isRateLimited(res: Response): boolean {
  if (res.status === 429) return true;
  if (res.status === 403 && res.headers.get("X-RateLimit-Remaining") === "0")
    return true;
  return false;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Get an installation token for `installId`, minting (and caching) one if absent or
 * near expiry. The cache key is product-scoped so two products that share a GitHub
 * App but have distinct installations never collide.
 */
export async function getInstallationToken(
  env: Env,
  product: string,
  installId: number,
  now: number,
  fetchImpl: FetchImpl = fetch,
): Promise<string> {
  const cacheKey = pk(product, "gh-token", String(installId));
  const cached = await env.HOT.get(cacheKey);
  if (cached) {
    const rec = JSON.parse(cached) as CachedToken;
    // 60s safety margin so a token can't expire mid-stream.
    if (rec.expiresAt > now + 60) return rec.token;
  }

  const jwt = await appJwt(env, now);
  const url = `${GITHUB_API}/app/installations/${installId}/access_tokens`;
  const post = (): Promise<Response> =>
    fetchImpl(url, { method: "POST", headers: githubHeaders(`Bearer ${jwt}`) });

  let res = await post();
  // One polite retry on a rate-limit signal, honoring Retry-After / X-RateLimit-Reset.
  if (isRateLimited(res)) {
    await sleep(backoffMillis(res));
    res = await post();
  }
  if (!res.ok) throw new Error(`installation token failed: ${res.status}`);
  const body = (await res.json()) as { token: string };

  const expiresAt = now + TOKEN_TTL_SECONDS;
  await env.HOT.put(
    cacheKey,
    JSON.stringify({ token: body.token, expiresAt } satisfies CachedToken),
    { expirationTtl: TOKEN_TTL_SECONDS },
  );
  return body.token;
}
