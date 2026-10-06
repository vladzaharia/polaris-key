/// <reference types="@cloudflare/workers-types" />

/**
 * GitHub App authentication for the release engine.
 *
 * We mint a short-lived App JWT (RS256, signed with the App's PEM private key via
 * WebCrypto in `core/jwt.ts` — no node:* crypto) then exchange it for an **installation token** down-scoped
 * to a single repository and a read-only permission set. Tokens are cached in KV — sealed,
 * never plaintext — so the common path is a single KV read, not two GitHub round-trips.
 *
 * Everything here is pure given an injected `fetchImpl`, so the whole flow is testable
 * with no network. The only ambient dependency is WebCrypto, which workerd provides.
 */

import {
  ghInstallationTokenKey,
  open,
  seal,
  secret,
  type Env,
  type SealContext,
} from "../../core/platform.js";
import { signJwtRs256 } from "../../core/jwt.js";
import { MANIFEST_FILES } from "./manifestFiles.js";

const GITHUB_API = "https://api.github.com";
const USER_AGENT = "polaris-key-release";
/** Installation tokens live ~60m; cache for 55m to leave headroom. */
const TOKEN_TTL_SECONDS = 55 * 60;

/** A fetch with the same shape as the platform `fetch`, injectable for tests. */
export type FetchImpl = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/** Sign the App JWT (GitHub App JWTs are RS256; `core/jwt.ts` owns the signer). */
async function signAppJwt(
  appId: string,
  pem: string,
  now: number,
): Promise<string> {
  // 30s clock-skew backdate; 9-minute window (GitHub caps App JWTs at 10m).
  const payload = { iat: now - 30, exp: now + 9 * 60, iss: appId };
  return signJwtRs256(payload, pem);
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

// ── what the App can read (UX-72: FLOWS.md §3.11 W22) ─────────────────────────────────────────

/** Cap on one GitHub listing page (100 repositories is ~0.5 MB of JSON; allow headroom). */
const MAX_LISTING_BYTES = 4 * 1024 * 1024;
/** Pages read per listing: 100 installations or 1,000 repositories per installation at most. */
const MAX_INSTALLATION_PAGES = 1;
const MAX_REPOSITORY_PAGES = 10;
const PER_PAGE = 100;

/** Read a JSON body of at most `maxBytes`, cancelling the stream once the cap is passed. */
async function readJsonCapped<T>(res: Response, maxBytes: number): Promise<T> {
  const declared = Number(res.headers.get("Content-Length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new Error("github listing: response too large");
  if (!res.body) return JSON.parse(await res.text()) as T;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("github listing: response too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

/** GET with one polite retry on a rate-limit signal; throws on anything but 2xx. */
async function getListing<T>(
  url: string,
  auth: string,
  fetchImpl: FetchImpl,
): Promise<T> {
  let res = await fetchImpl(url, { headers: githubHeaders(auth) });
  if (isRateLimited(res)) {
    await sleep(backoffMillis(res));
    res = await fetchImpl(url, { headers: githubHeaders(auth) });
  }
  if (!res.ok) throw new Error(`github listing failed: ${res.status}`);
  return readJsonCapped<T>(res, MAX_LISTING_BYTES);
}

/** The App itself: its slug and the page an account installs it from. */
export interface GithubAppInfo {
  slug: string;
  /** `https://github.com/apps/<slug>/installations/new`: Install on GitHub. */
  installUrl: string;
}

/** `GET /app` as the App. Throws when the App is not configured or GitHub refuses. */
export async function getAppInfo(
  env: Env,
  now: number,
  fetchImpl: FetchImpl = fetch,
): Promise<GithubAppInfo> {
  const jwt = await appJwt(env, now);
  const body = await getListing<{ slug?: unknown; html_url?: unknown }>(
    `${GITHUB_API}/app`,
    `Bearer ${jwt}`,
    fetchImpl,
  );
  if (typeof body.slug !== "string" || typeof body.html_url !== "string")
    throw new Error("github app: unexpected shape");
  const page = new URL(body.html_url);
  if (page.protocol !== "https:" || page.hostname !== "github.com")
    throw new Error("github app: unexpected page");
  return {
    slug: body.slug,
    installUrl: `${page.origin}${page.pathname.replace(/\/+$/, "")}/installations/new`,
  };
}

/** One installation of the App: the account it is on and what it may do there. */
export interface GithubInstallation {
  id: number;
  account: string;
  accountType: string;
  /** `all` or `selected`: whether the account gave the App every repository or a list. */
  repositorySelection: string;
  /** GitHub's permission grant, `{ contents: "read", … }`. */
  permissions: Record<string, string>;
}

/**
 * Every active installation of the App (`GET /app/installations`, as the App). Suspended
 * installations are left out: GitHub refuses them a token, so they can list nothing.
 */
export async function listInstallations(
  env: Env,
  now: number,
  fetchImpl: FetchImpl = fetch,
): Promise<GithubInstallation[]> {
  const jwt = await appJwt(env, now);
  const out: GithubInstallation[] = [];
  for (let page = 1; page <= MAX_INSTALLATION_PAGES; page++) {
    const rows = await getListing<unknown[]>(
      `${GITHUB_API}/app/installations?per_page=${PER_PAGE}&page=${page}`,
      `Bearer ${jwt}`,
      fetchImpl,
    );
    if (!Array.isArray(rows))
      throw new Error("github installations: unexpected shape");
    for (const r of rows) {
      const row = r as {
        id?: unknown;
        account?: { login?: unknown; type?: unknown } | null;
        repository_selection?: unknown;
        permissions?: unknown;
        suspended_at?: unknown;
      };
      if (typeof row.id !== "number" || typeof row.account?.login !== "string")
        continue;
      // A suspended installation cannot mint a token (GitHub answers 403); it reads nothing.
      if (row.suspended_at != null) continue;
      const permissions: Record<string, string> = {};
      if (row.permissions && typeof row.permissions === "object")
        for (const [k, v] of Object.entries(row.permissions))
          if (typeof v === "string") permissions[k] = v;
      out.push({
        id: row.id,
        account: row.account.login,
        accountType:
          typeof row.account.type === "string" ? row.account.type : "User",
        repositorySelection:
          typeof row.repository_selection === "string"
            ? row.repository_selection
            : "selected",
        permissions,
      });
    }
    if (rows.length < PER_PAGE) break;
  }
  return out;
}

/** A repository an installation can read, as the picker lists it. */
export interface GithubRepository {
  installationId: number;
  owner: string;
  name: string;
  /** `owner/name` as GitHub spells it. */
  fullName: string;
  language: string | null;
  /** Unix seconds of the last push, or null for an empty repository. */
  pushedAt: number | null;
  private: boolean;
  defaultBranch: string | null;
}

/**
 * Mint a token for an installation outside the release read path, uncached: `metadata: read`
 * across the installation (what listing its repositories needs, and nothing that reads
 * content), or `contents: read` narrowed to the named repositories (the `.pkey/` probe).
 */
async function mintListingToken(
  env: Env,
  installId: number,
  now: number,
  fetchImpl: FetchImpl,
  repositories?: string[],
): Promise<string> {
  const jwt = await appJwt(env, now);
  const body = repositories
    ? { repositories, permissions: BASE_PERMISSIONS }
    : { permissions: { metadata: "read" } };
  const res = await fetchImpl(
    `${GITHUB_API}/app/installations/${installId}/access_tokens`,
    {
      method: "POST",
      headers: {
        ...githubHeaders(`Bearer ${jwt}`),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw new Error(`installation token failed: ${res.status}`);
  const out = (await res.json()) as { token?: unknown };
  if (typeof out.token !== "string")
    throw new Error("installation token: unexpected shape");
  return out.token;
}

/** Every repository one installation can read (`GET /installation/repositories`). */
export async function listInstallationRepositories(
  env: Env,
  installId: number,
  now: number,
  fetchImpl: FetchImpl = fetch,
): Promise<GithubRepository[]> {
  const token = await mintListingToken(env, installId, now, fetchImpl);
  const out: GithubRepository[] = [];
  for (let page = 1; page <= MAX_REPOSITORY_PAGES; page++) {
    const body = await getListing<{ repositories?: unknown }>(
      `${GITHUB_API}/installation/repositories?per_page=${PER_PAGE}&page=${page}`,
      `token ${token}`,
      fetchImpl,
    );
    const rows = Array.isArray(body.repositories) ? body.repositories : null;
    if (!rows) throw new Error("github repositories: unexpected shape");
    for (const r of rows) {
      const row = r as {
        name?: unknown;
        full_name?: unknown;
        owner?: { login?: unknown } | null;
        language?: unknown;
        pushed_at?: unknown;
        private?: unknown;
        default_branch?: unknown;
      };
      if (
        typeof row.name !== "string" ||
        typeof row.full_name !== "string" ||
        typeof row.owner?.login !== "string"
      )
        continue;
      const pushed =
        typeof row.pushed_at === "string" ? Date.parse(row.pushed_at) : NaN;
      out.push({
        installationId: installId,
        owner: row.owner.login,
        name: row.name,
        fullName: row.full_name,
        language: typeof row.language === "string" ? row.language : null,
        pushedAt: Number.isFinite(pushed) ? Math.floor(pushed / 1000) : null,
        private: row.private === true,
        defaultBranch:
          typeof row.default_branch === "string" ? row.default_branch : null,
      });
    }
    if (rows.length < PER_PAGE) break;
  }
  return out;
}

/** The names `.pkey/product` may have (`manifestFiles.ts`'s product variants). */
const PRODUCT_MANIFEST_NAMES = new Set(
  MANIFEST_FILES.product.map((p) => p.slice(p.lastIndexOf("/") + 1)),
);
const isProductManifestName = (name: string): boolean =>
  PRODUCT_MANIFEST_NAMES.has(name);

/**
 * Does each repository have a `.pkey/product` on its default branch? One `contents/.pkey`
 * directory read per repository, with one token narrowed to these repositories and
 * `contents: read`. `true`/`false`, or `null` when GitHub would not say (a rate limit, an
 * error): the picker then shows no mark rather than a wrong one.
 */
export async function probeManifests(
  env: Env,
  installId: number,
  repos: readonly { owner: string; name: string }[],
  now: number,
  fetchImpl: FetchImpl = fetch,
): Promise<Map<string, boolean | null>> {
  const out = new Map<string, boolean | null>();
  if (repos.length === 0) return out;
  let token: string;
  try {
    token = await mintListingToken(
      env,
      installId,
      now,
      fetchImpl,
      repos.map((r) => r.name),
    );
  } catch {
    for (const r of repos) out.set(`${r.owner}/${r.name}`, null);
    return out;
  }
  await Promise.all(
    repos.map(async (r) => {
      const key = `${r.owner}/${r.name}`;
      try {
        const res = await fetchImpl(
          `${GITHUB_API}/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.name)}/contents/.pkey`,
          { headers: githubHeaders(`token ${token}`) },
        );
        if (res.status === 404) {
          out.set(key, false);
          return;
        }
        if (!res.ok) {
          out.set(key, null);
          return;
        }
        const entries = await readJsonCapped<unknown>(res, MAX_LISTING_BYTES);
        out.set(
          key,
          Array.isArray(entries) &&
            entries.some(
              (e) =>
                typeof (e as { name?: unknown }).name === "string" &&
                (e as { type?: unknown }).type === "file" &&
                isProductManifestName((e as { name: string }).name),
            ),
        );
      } catch {
        out.set(key, null);
      }
    }),
  );
  return out;
}
