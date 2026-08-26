/// <reference types="@cloudflare/workers-types" />

/**
 * GitHub App authentication for the release engine.
 *
 * We mint a short-lived App JWT (ES256, signed with the App's PEM private key via
 * WebCrypto — no node:* crypto) then exchange it for an **installation token** down-scoped
 * to a single repository and a read-only permission set. Tokens are cached in KV — sealed,
 * never plaintext — so the common path is a single KV read, not two GitHub round-trips.
 *
 * Everything here is pure given an injected `fetchImpl`, so the whole flow is testable
 * with no network. The only ambient dependency is WebCrypto, which workerd provides.
 */

import { type Env, secret } from "../env.js";
import { ghInstallationTokenKey } from "../kv.js";
import { open, seal, type SealContext } from "../keyvault.js";

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
  /** The down-scope GitHub actually granted: `"<owner>/<repo>"`, or `"*"` if unrestricted. */
  granted: string;
}

/**
 * What the release engine asks a token for.
 *
 * The structured form is what a caller that knows its repo coordinates should pass: it
 * produces a token GitHub has restricted to exactly that repository. A bare `string` is the
 * legacy form (see `ghInstallationTokenKey`'s note on the caller disagreement) — it is
 * treated as a best-effort repo name, and if GitHub rejects it as one we fall back rather
 * than break the caller.
 */
export interface InstallationTokenScope {
  owner: string;
  repo: string;
  /**
   * True when the caller resolves beta/PR channels through the Actions API
   * (`release/index.ts` `channelTagsFor`), which needs two read permissions beyond the
   * release read path. Off by default so the common token stays as small as possible.
   */
  channelWorkflow?: boolean;
}

/**
 * The minimum permission set the release read path needs.
 *
 * `contents: read` covers `/releases`, `/releases/tags/*`, `/releases/latest`,
 * `/releases/assets/*` and `/contents/*` (the `.pkey/` manifests). `metadata: read` is
 * mandatory for every App. Nothing here writes, so nothing here asks for write.
 */
const BASE_PERMISSIONS: Readonly<Record<string, string>> = {
  contents: "read",
  metadata: "read",
};

/**
 * Adds the two scopes `channelTagsFor` needs: the workflow-runs endpoint (actions) and
 * `/pulls/{n}` (pull_requests). Requested only when a `channel_workflow` is configured,
 * because GitHub 422s a token request for a permission the App was never granted.
 */
const CHANNEL_PERMISSIONS: Readonly<Record<string, string>> = {
  ...BASE_PERMISSIONS,
  actions: "read",
  pull_requests: "read",
};

/** Installation-wide, i.e. no `repositories` restriction. */
const UNSCOPED = "*";

function normalizeScope(scope: InstallationTokenScope | string): {
  /** Repo name sent as `repositories: [name]`. */
  repo: string;
  /** Stable cache-scope descriptor; also the AAD the cached token is sealed against. */
  descriptor: string;
  permissions: Readonly<Record<string, string>>;
  /** Legacy bare-string callers may not have passed a repo name at all. */
  legacy: boolean;
} {
  if (typeof scope === "string") {
    return {
      repo: scope,
      // No owner is available in the legacy form, so the descriptor cannot claim one.
      descriptor: `?/${scope}`,
      permissions: BASE_PERMISSIONS,
      legacy: true,
    };
  }
  return {
    repo: scope.repo,
    descriptor: `${scope.owner}/${scope.repo}`,
    permissions: scope.channelWorkflow ? CHANNEL_PERMISSIONS : BASE_PERMISSIONS,
    legacy: false,
  };
}

/**
 * Where a cached installation token lives and what it is sealed against.
 *
 * Exported so nothing — production or test — has to re-derive the at-rest format by hand.
 * The `SealContext`'s `product` is not a product: an installation token has no product
 * dimension, so it carries `gh:<installId>`, which can never collide with a real slug
 * (slugs cannot contain `:`). The scope descriptor is the AAD's `id`, so a blob sealed for
 * one repo scope cannot be opened as another's even if the key were guessed.
 */
export function installationTokenSlot(
  installId: number,
  scope: InstallationTokenScope | string,
): { key: string; ctx: SealContext } {
  const { descriptor } = normalizeScope(scope);
  return {
    key: ghInstallationTokenKey(installId, descriptor),
    ctx: {
      product: `gh:${installId}`,
      kind: "product-secret",
      id: `gh-token:${descriptor}`,
    },
  };
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

/** GitHub's answer when a `repositories` / `permissions` narrowing cannot be satisfied. */
function isNarrowingRejected(status: number): boolean {
  return status === 404 || status === 422;
}

/**
 * Get an installation token for `installId`, minting (and caching) one if absent or near
 * expiry.
 *
 * R5-03. The mint used to send **no request body**, so an org-wide installation handed back
 * a token valid for every repository in the org — one product's appcast path held read/write
 * credentials for every other product's repo. It now POSTs `repositories` + a read-only
 * `permissions` set, which GitHub enforces server-side on the issued token.
 *
 * The cache key is derived here, from `installId` + the requested down-scope
 * (`ghInstallationTokenKey`), and never from the caller's second argument — callers disagree
 * about what that argument means, and with `installId` constant across an org-wide install
 * that disagreement is what made one shared cache entry defeat the scoping.
 *
 * R12-03. The cached record is sealed under `PLATFORM_KEK` before it is written, so a KV dump
 * yields ciphertext rather than a live GitHub bearer token. If sealing is impossible (no KEK)
 * we simply do not cache: an extra round trip per request is the correct price, persisting a
 * plaintext credential is not.
 */
export async function getInstallationToken(
  env: Env,
  scope: InstallationTokenScope | string,
  installId: number,
  now: number,
  fetchImpl: FetchImpl = fetch,
): Promise<string> {
  const { repo, descriptor, permissions, legacy } = normalizeScope(scope);
  const { key: cacheKey, ctx } = installationTokenSlot(installId, scope);

  const cached = await env.HOT.get(cacheKey);
  if (cached) {
    // A blob that will not open (rotated KEK, tampered ciphertext, legacy plaintext record)
    // is treated as a miss and re-minted — never as a usable token.
    try {
      const rec = JSON.parse(await open(env, cached, ctx)) as CachedToken;
      // 60s safety margin so a token can't expire mid-stream.
      if (typeof rec.token === "string" && rec.expiresAt > now + 60)
        return rec.token;
    } catch {
      /* fall through to a fresh mint */
    }
  }

  const jwt = await appJwt(env, now);
  const url = `${GITHUB_API}/app/installations/${installId}/access_tokens`;
  const post = (body: Record<string, unknown>): Promise<Response> =>
    fetchImpl(url, {
      method: "POST",
      headers: {
        ...githubHeaders(`Bearer ${jwt}`),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

  /**
   * Narrowest first. Each fallback exists because GitHub 422s a narrowing it cannot satisfy,
   * and a 422 here takes the whole release surface down:
   *  1. the requested repo + permission set — what every correctly-wired caller gets;
   *  2. same repo, base permissions — for an App never granted actions/pull_requests;
   *  3. installation-wide but still read-only — only for the legacy bare-string form, whose
   *     argument may be a product slug rather than a repo name (`release/health.ts`).
   */
  const attempts: Array<{ body: Record<string, unknown>; granted: string }> = [
    { body: { repositories: [repo], permissions }, granted: descriptor },
  ];
  if (permissions !== BASE_PERMISSIONS) {
    attempts.push({
      body: { repositories: [repo], permissions: BASE_PERMISSIONS },
      granted: descriptor,
    });
  }
  if (legacy) {
    attempts.push({
      body: { permissions: BASE_PERMISSIONS },
      granted: UNSCOPED,
    });
  }

  let res: Response | null = null;
  let granted = descriptor;
  for (const [i, attempt] of attempts.entries()) {
    res = await post(attempt.body);
    // One polite retry on a rate-limit signal, honoring Retry-After / X-RateLimit-Reset.
    if (isRateLimited(res)) {
      await sleep(backoffMillis(res));
      res = await post(attempt.body);
    }
    granted = attempt.granted;
    if (res.ok) break;
    if (!isNarrowingRejected(res.status) || i === attempts.length - 1) break;
  }
  if (!res || !res.ok)
    throw new Error(`installation token failed: ${res?.status ?? 0}`);
  const body = (await res.json()) as { token: string };

  const expiresAt = now + TOKEN_TTL_SECONDS;
  const rec: CachedToken = { token: body.token, expiresAt, granted };
  try {
    await env.HOT.put(cacheKey, await seal(env, JSON.stringify(rec), ctx), {
      expirationTtl: TOKEN_TTL_SECONDS,
    });
  } catch {
    // No KEK configured (or a KEK that will not import): serve the token, cache nothing.
  }
  return body.token;
}
