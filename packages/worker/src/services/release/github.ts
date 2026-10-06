/// <reference types="@cloudflare/workers-types" />

/**
 * Authenticated GitHub Releases client.
 *
 * This is repo-agnostic: every call takes an explicit
 * `(token, owner, repo)` so one engine serves many products, and an injectable
 * `fetchImpl` so the whole module unit-tests without network. Any auth/visibility
 * error (401/403/404) is mapped to a clean `NotFoundError` so callers never reveal
 * that a repo is private or that a token exists.
 */

import type { FetchImpl } from "./githubApp.js";
import { isAllowedStorageHost } from "../../core/platform.js";
import { readCappedText } from "../../core/readCapped.js";
import { MAX_MANIFEST_BYTES } from "./manifest.js";

/**
 * The storage-host allowlist, re-exported for this module's own callers.
 *
 * The definition moved to the platform layer when Identity was carved (P3): the portal's
 * `/download/<token>` redirect validates against the SAME list (R6-12), and a service may not
 * import a sibling. Re-exported rather than repointed so every existing importer — and the
 * suites that pin this predicate — sees an unchanged surface.
 */
export { isAllowedStorageHost } from "../../core/platform.js";

const GITHUB_API = "https://api.github.com";
const USER_AGENT = "polaris-key-release";

export interface ReleaseAsset {
  id: number;
  name: string;
  size: number;
  content_type: string;
  browser_download_url: string;
  /**
   * GitHub's own digest of the uploaded bytes, `sha256:<hex>` (P2-04). Computed by GitHub, so
   * it is the bytes' hash, not the uploader's claim. Absent on assets uploaded before GitHub
   * began recording digests, and in older API responses.
   */
  digest?: string | null;
}

export interface Release {
  tag_name: string;
  name: string | null;
  body: string | null;
  published_at: string | null;
  html_url: string;
  prerelease: boolean;
  draft: boolean;
  /**
   * True for a GitHub immutable release (P2-04): its tag and assets can no longer change after
   * publication. Descriptor ingest requires it wherever GitHub is the source of bytes; absent
   * (an older API response, or a repo without immutable releases) counts as mutable.
   */
  immutable?: boolean;
  assets: ReleaseAsset[];
}

/** The lower-case hex SHA-256 in a GitHub asset `digest` (`sha256:<hex>`), or null. */
export function assetSha256(
  asset: Pick<ReleaseAsset, "digest">,
): string | null {
  const m = /^sha256:([0-9a-fA-F]{64})$/.exec(asset.digest ?? "");
  return m ? m[1]!.toLowerCase() : null;
}

/** Thrown internally; callers map this to a 404 response. */
export class NotFoundError extends Error {}

/**
 * Thrown when GitHub itself is refusing us for quota reasons (R10-05).
 *
 * Every other auth/visibility failure is deliberately flattened to `NotFoundError` so this
 * gateway never reveals whether a repo is private. Quota exhaustion is different: it is a
 * *platform* condition, it affects every product on that installation at once, and mapping it
 * to 404 is what turned "we are rate limited" into "this product has no releases" —
 * indistinguishable, from the outside, from a pulled release. Callers map this to 503 so an
 * operator (and a well-behaved auto-updater) can tell exhaustion from absence.
 */
export class UpstreamRateLimitedError extends Error {
  constructor(
    message: string,
    /** Seconds to wait, when GitHub told us; undefined when it did not. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

/**
 * Recognise GitHub's two quota signals: a 429, or a 403 whose `x-ratelimit-remaining` is 0
 * (primary limit) or which carries a `retry-after` (secondary limit). A bare 403 with neither
 * is a permissions/visibility answer and stays a `NotFoundError`.
 */
function rateLimitSignal(res: Response): UpstreamRateLimitedError | null {
  const header = res.headers.get("Retry-After");
  // `Number(null)` and `Number("")` are both 0, which would make an ABSENT header look like
  // "retry immediately" and turn every plain 403 (private repo) into a quota signal.
  const retryAfter = header === null ? Number.NaN : Number(header);
  const seconds =
    Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : undefined;
  if (res.status === 429)
    return new UpstreamRateLimitedError("github rate limited: 429", seconds);
  if (res.status === 403) {
    if (
      res.headers.get("X-RateLimit-Remaining") === "0" ||
      seconds !== undefined
    ) {
      return new UpstreamRateLimitedError("github rate limited: 403", seconds);
    }
  }
  return null;
}

/** Throw `UpstreamRateLimitedError` if `res` is a GitHub quota refusal; otherwise return. */
function throwIfRateLimited(res: Response): void {
  const signal = rateLimitSignal(res);
  if (signal) throw signal;
}

function apiHeaders(token: string, accept: string): HeadersInit {
  return {
    Accept: accept,
    Authorization: `Bearer ${token}`,
    "User-Agent": USER_AGENT,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/**
 * Resolve a release by version. `latest`/undefined hits `/releases/latest`; anything else is a
 * pinned version, looked up as `tags/v<version>` and — only when that 404s — as
 * `tags/<version>`, so a repo that tags `1.2.3` (no `v`) can be pinned and its stable appcast's
 * pinned enclosure resolves. Any other failure is not retried: a 403 is a visibility answer,
 * and asking twice would only double the quota spent learning it.
 */
export async function resolveRelease(
  token: string,
  owner: string,
  repo: string,
  version: string | undefined,
  fetchImpl: FetchImpl = fetch,
): Promise<Release> {
  const base = `${GITHUB_API}/repos/${owner}/${repo}/releases`;
  if (!version || version === "latest") {
    const res = await fetchImpl(`${base}/latest`, {
      headers: apiHeaders(token, "application/vnd.github+json"),
    });
    throwIfRateLimited(res);
    if (!res.ok)
      throw new NotFoundError(`release lookup failed: ${res.status}`);
    return (await res.json()) as Release;
  }
  const prefixed = await getReleaseByTag(
    token,
    owner,
    repo,
    `v${version}`,
    fetchImpl,
  );
  if (prefixed) return prefixed;
  const bare = await getReleaseByTag(token, owner, repo, version, fetchImpl);
  if (bare) return bare;
  throw new NotFoundError("release lookup failed: 404");
}

/**
 * One release by its exact tag: `null` on 404, `NotFoundError` on any other refusal (so a
 * private repo is still indistinguishable from an absent one), `UpstreamRateLimitedError` on
 * quota. Used by the pinned lookup above and by the R6-10 floor check, which needs to know
 * whether the floor's release still EXISTS — a question a 404 answers and a 403 does not.
 */
export async function getReleaseByTag(
  token: string,
  owner: string,
  repo: string,
  tag: string,
  fetchImpl: FetchImpl = fetch,
): Promise<Release | null> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`;
  const res = await fetchImpl(url, {
    headers: apiHeaders(token, "application/vnd.github+json"),
  });
  throwIfRateLimited(res);
  if (res.status === 404) return null;
  if (!res.ok) throw new NotFoundError(`release lookup failed: ${res.status}`);
  return (await res.json()) as Release;
}

/** Page budgets for `listReleases` callers (P0-02). */
export const RELEASE_PAGE_CAP = {
  /** The truth-store sync: 10 pages of 100, i.e. up to 1,000 releases. */
  sync: 10,
  /** Live resolution: read on until a candidate has been seen, but never past 3 pages. */
  live: 3,
} as const;

export interface ListReleasesOptions {
  /** Pages to read at most (default 1: the pre-pagination behaviour). */
  maxPages?: number;
  /**
   * Stop early once this returns true. `page` is the page just read, so a per-release predicate
   * can look at each entry once instead of re-scanning `soFar` after every page.
   */
  stopWhen?: (soFar: Release[], page: Release[]) => boolean;
}

/**
 * The `rel="next"` target of a GitHub `Link` header, or null.
 *
 * The URL is used only when it is on the GitHub API origin: this request carries the
 * installation token, and a `Link` pointing anywhere else must not be followed with it.
 */
export function nextPageUrl(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="?next"?/);
    if (!m || !m[1]) continue;
    try {
      const url = new URL(m[1]);
      return url.origin === GITHUB_API ? url.toString() : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * List published releases (newest first by creation), following `Link: rel="next"` up to
 * `opts.maxPages` pages. Each page is one GitHub subrequest, so callers choose the cap:
 * `RELEASE_PAGE_CAP.sync` for the truth store, `RELEASE_PAGE_CAP.live` (with a `stopWhen`) for
 * request-time resolution, and the default single page everywhere else.
 */
export async function listReleases(
  token: string,
  owner: string,
  repo: string,
  perPage = 100,
  fetchImpl: FetchImpl = fetch,
  opts: ListReleasesOptions = {},
): Promise<Release[]> {
  return (await listReleasePages(token, owner, repo, perPage, fetchImpl, opts))
    .releases;
}

/** What `listReleasePages` read, and whether that was the whole list. */
export interface ReleaseListing {
  releases: Release[];
  /**
   * True only when the last page read carried no `rel="next"` link: the list was read to its
   * end, so a release missing from it is missing upstream. False when the page cap or a
   * `stopWhen` cut the read short — absence then proves nothing (P0-03).
   */
  complete: boolean;
}

/** `listReleases`, also reporting whether the list was read to the end. */
export async function listReleasePages(
  token: string,
  owner: string,
  repo: string,
  perPage = 100,
  fetchImpl: FetchImpl = fetch,
  opts: ListReleasesOptions = {},
): Promise<ReleaseListing> {
  const maxPages = Math.max(1, opts.maxPages ?? 1);
  let url: string | null =
    `${GITHUB_API}/repos/${owner}/${repo}/releases?per_page=${perPage}`;
  const out: Release[] = [];
  for (let page = 0; url && page < maxPages; page++) {
    const res = await fetchImpl(url, {
      headers: apiHeaders(token, "application/vnd.github+json"),
    });
    throwIfRateLimited(res);
    if (!res.ok) throw new NotFoundError(`releases list failed: ${res.status}`);
    const body: unknown = await res.json();
    // An off-shape page (an error envelope, a proxy's HTML) is not a release list; iterating it
    // would 500 the route.
    if (!Array.isArray(body))
      throw new NotFoundError("releases list: unexpected shape");
    const pageReleases = body as Release[];
    out.push(...pageReleases);
    if (opts.stopWhen?.(out, pageReleases))
      return { releases: out, complete: false };
    const link = res.headers.get("Link");
    url = nextPageUrl(link);
    // A `next` link this client refused to follow (off-origin, unparseable) still means the
    // list goes on: stop reading, but never call what was read the whole list.
    if (url === null && link !== null && /rel="?next"?/.test(link))
      return { releases: out, complete: false };
  }
  return { releases: out, complete: url === null };
}

/** Strip an upstream asset name down to something safe inside a `filename="…"` parameter. */
function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  return cleaned.slice(0, 128) || "download";
}

export interface StreamAssetOptions {
  /** Upstream asset name; sanitised into the forced `Content-Disposition`. */
  filename: string;
  /**
   * The `Content-Type` this gateway will serve. Chosen by the caller from its own
   * allowlist — the upstream value is repo-controlled and is never relayed (R6-04).
   */
  contentType: string;
}

/**
 * A cache for the asset's signed storage URL (P2-05, `ghCache.ts`). With one, a request whose
 * URL is cached skips the API call entirely — which is what makes a `Range` chunk free — and a
 * fresh redirect is remembered for the next one.
 */
export interface SignedUrlCache {
  get(): Promise<string | null>;
  put(url: string): Promise<void>;
  drop(): Promise<void>;
}

/**
 * Stream a release asset's raw bytes back to the client. Requests the asset with
 * `Accept: application/octet-stream`; GitHub answers with a 302 to its storage
 * backend. We follow that redirect **manually** so we can SSRF-guard the redirect
 * target host before re-fetching, and pass Range/ETag through so range requests and
 * caching keep working end-to-end.
 *
 * SECURITY (R6-04). A GitHub release asset's `content_type` is chosen by whoever uploaded
 * it, and this gateway shares an origin with the admin SPA and the customer portal. So the
 * response type is forced from `opts.contentType`, `Content-Disposition: attachment` is
 * always sent (GitHub sets one; the old header allowlist dropped it), and `nosniff` is set
 * so a mislabelled body can never be sniffed into same-origin script.
 *
 * `token` may be a function, so a request served from `urlCache` never mints or reads an
 * installation token at all.
 */
export async function streamAsset(
  token: string | (() => Promise<string>),
  owner: string,
  repo: string,
  assetId: number,
  clientRequest: Request,
  opts: StreamAssetOptions,
  fetchImpl: FetchImpl = fetch,
  urlCache?: SignedUrlCache,
): Promise<Response> {
  const range = clientRequest.headers.get("Range");
  const ifNoneMatch = clientRequest.headers.get("If-None-Match");
  const storageHeaders = (): Headers => {
    const h = new Headers();
    if (range) h.set("Range", range);
    if (ifNoneMatch) h.set("If-None-Match", ifNoneMatch);
    return h;
  };

  let upstream: Response | null = null;
  const cached = urlCache ? await urlCache.get() : null;
  if (cached && isAllowedStorageHost(new URL(cached).hostname)) {
    const res = await fetchImpl(cached, { headers: storageHeaders() });
    // An expired or revoked signature: forget it and ask the API for a fresh one.
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => undefined);
      await urlCache?.drop();
    } else {
      upstream = res;
    }
  }

  if (!upstream) {
    const tok = typeof token === "string" ? token : await token();
    const headers = new Headers(apiHeaders(tok, "application/octet-stream"));
    if (range) headers.set("Range", range);
    if (ifNoneMatch) headers.set("If-None-Match", ifNoneMatch);

    const url = `${GITHUB_API}/repos/${owner}/${repo}/releases/assets/${assetId}`;
    upstream = await fetchImpl(url, { headers, redirect: "manual" });

    if (upstream.status >= 300 && upstream.status < 400) {
      const loc = upstream.headers.get("Location");
      if (!loc) throw new NotFoundError("asset redirect: missing location");
      // SSRF guard: only follow redirects into GitHub's own storage hosts.
      const host = new URL(loc).hostname;
      if (!isAllowedStorageHost(host))
        throw new NotFoundError(`asset redirect host not allowed: ${host}`);
      upstream = await fetchImpl(loc, { headers: storageHeaders() }); // signed URL — no Authorization
      if (urlCache && upstream.status >= 200 && upstream.status < 400)
        await urlCache.put(loc);
    }
  }

  throwIfRateLimited(upstream);
  if (
    upstream.status === 401 ||
    upstream.status === 403 ||
    upstream.status === 404
  ) {
    throw new NotFoundError(`asset fetch failed: ${upstream.status}`);
  }
  if (!upstream.ok && upstream.status !== 206 && upstream.status !== 304) {
    throw new NotFoundError(`asset fetch failed: ${upstream.status}`);
  }

  const out = new Headers();
  // NOTE: `Content-Type` is deliberately absent from this allowlist — it is set below from
  // the gateway's own choice, never from the repo-controlled upstream value.
  for (const h of [
    "Content-Length",
    "Content-Range",
    "Accept-Ranges",
    "ETag",
    "Last-Modified",
  ]) {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }
  out.set("Content-Type", opts.contentType);
  out.set(
    "Content-Disposition",
    `attachment; filename="${sanitizeFilename(opts.filename)}"`,
  );
  out.set("X-Content-Type-Options", "nosniff");
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

/**
 * Response-body budget for one `.pkey/` file read (R7-02, at the fetch rather than the parse).
 *
 * `parseDocument` caps the DECODED manifest at `MAX_MANIFEST_BYTES` (64 KiB) — but it only
 * gets to say so after this function has already pulled the whole body into the isolate and
 * base64-decoded it, which is the wrong end of a 128 MB memory budget to be discovering that a
 * repo writer committed a 200 MB `.pkey/product.yaml`. The Contents API answers with the file
 * base64-encoded (×4/3, plus a `\n` every 60 columns) inside a JSON envelope carrying ~1 KB of
 * metadata, so a legal 64 KiB manifest arrives as ~88 KiB. 2× the manifest cap clears that with
 * room to spare while still bounding the read, and anything between the two caps is refused a
 * moment later by the parser with a much better error message.
 */
export const MAX_REPO_FILE_BYTES = MAX_MANIFEST_BYTES * 2;

/**
 * Read a file from a repo via the GitHub Contents API. Returns the decoded UTF-8 text, or
 * `null` on 404 (file/ref absent). `ref` pins a branch/tag/sha; omitted ⇒ default branch.
 * Any other non-OK status maps to a `NotFoundError` so callers stay information-leak-free.
 *
 * The Contents API returns a JSON object whose `content` is base64 (with embedded newlines)
 * when `Accept: application/vnd.github+json`; we decode it here so callers get plain text.
 *
 * The body is read through `readCapped`, so `Content-Length` is consulted before a byte is
 * read AND the stream is cancelled the moment `MAX_REPO_FILE_BYTES` is passed — an absent or
 * lying header must not be able to defeat the cap.
 */
export async function fetchRepoFile(
  token: string,
  owner: string,
  repo: string,
  path: string,
  fetchImpl: FetchImpl = fetch,
  ref?: string,
): Promise<string | null> {
  const q = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${path
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/")}${q}`;
  const res = await fetchImpl(url, {
    headers: apiHeaders(token, "application/vnd.github+json"),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new NotFoundError(`repo file fetch failed: ${res.status}`);
  const raw = await readCapped(res, MAX_REPO_FILE_BYTES, "repo file");
  let body: { content?: string; encoding?: string };
  try {
    body = JSON.parse(raw) as { content?: string; encoding?: string };
  } catch {
    throw new NotFoundError("repo file: unparseable response");
  }
  if (typeof body.content !== "string")
    throw new NotFoundError("repo file: unexpected shape");
  if (body.encoding && body.encoding !== "base64") {
    throw new NotFoundError(`repo file: unexpected encoding ${body.encoding}`);
  }
  // GitHub base64-wraps the content at 60 cols with `\n`; strip whitespace before decoding.
  const bin = atob(body.content.replace(/\s+/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** A repository's stable numeric identity (P2-02's publisher policy pins these, not names). */
export interface RepoIdentity {
  id: number;
  ownerId: number;
  /** `owner/repo` as GitHub spells it today. */
  fullName: string;
}

/**
 * `GET /repos/{owner}/{repo}` with the installation token: the numeric repository and owner ids
 * the trusted-publisher policy compares OIDC claims against (notes/E5: pin the numbers, not
 * `sub`, against name recycling). Always resolved from GitHub, never from a manifest. Throws
 * `NotFoundError` on any refusal or unexpected shape.
 */
export async function getRepoIdentity(
  token: string,
  owner: string,
  repo: string,
  fetchImpl: FetchImpl = fetch,
): Promise<RepoIdentity> {
  const res = await fetchImpl(
    `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    { headers: apiHeaders(token, "application/vnd.github+json") },
  );
  throwIfRateLimited(res);
  if (!res.ok)
    throw new NotFoundError(`repository lookup failed: ${res.status}`);
  const raw = await readCapped(res, MAX_REPO_FILE_BYTES, "repository");
  let body: { id?: unknown; full_name?: unknown; owner?: { id?: unknown } };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    throw new NotFoundError("repository: unparseable response");
  }
  const id = body.id;
  const ownerId = body.owner?.id;
  if (
    typeof id !== "number" ||
    !Number.isSafeInteger(id) ||
    typeof ownerId !== "number" ||
    !Number.isSafeInteger(ownerId) ||
    typeof body.full_name !== "string"
  )
    throw new NotFoundError("repository: unexpected shape");
  return { id, ownerId, fullName: body.full_name };
}

/** A commit id as GitHub returns it: SHA-1 (40 hex) or SHA-256 (64 hex), lowercase. */
const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * The commit the repository's DEFAULT branch points at right now (ST-01a, notes/S-18 §4.3).
 *
 * One read, answered by GitHub from `owner`/`repo` alone: `GET /repos/{o}/{r}/commits/HEAD` with
 * `Accept: application/vnd.github.sha`. `HEAD` is the repository's own symbolic ref, i.e. its
 * default branch, and the `sha` media type answers with the bare commit id rather than the full
 * commit JSON (whose file list and patches could exceed any sane read cap). This replaces the
 * two-call sketch in notes/S-18 §4.3 (`GET /repos/{o}/{r}`, then `/commits/{branch}`) with the
 * same property and one round trip; verified against api.github.com on 2026-10-04.
 *
 * Nothing caller-supplied picks the branch or the commit, so pinning every manifest document to
 * the returned sha keeps R6-05's property (the manifest applied is the DB-configured repository's
 * own default branch, as GitHub resolves it) while closing the window in which a push landing
 * between two Contents reads mixes documents from two commits. Throws `NotFoundError` on any
 * refusal or unexpected shape (rate limits as `UpstreamRateLimitedError`); callers fail the apply
 * closed rather than fall back to an unpinned read.
 */
export async function resolveDefaultBranchHead(
  token: string,
  owner: string,
  repo: string,
  fetchImpl: FetchImpl = fetch,
): Promise<{ sha: string }> {
  const res = await fetchImpl(
    `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/HEAD`,
    { headers: apiHeaders(token, "application/vnd.github.sha") },
  );
  throwIfRateLimited(res);
  if (!res.ok)
    throw new NotFoundError(`default branch head lookup failed: ${res.status}`);
  // 64 hex plus a trailing newline at most; anything longer is not a bare sha.
  const sha = (await readCapped(res, 256, "default branch head")).trim();
  if (!COMMIT_SHA.test(sha))
    throw new NotFoundError("default branch head: unexpected shape");
  return { sha };
}

/** The REST URL of one release asset: its metadata as JSON, its bytes as `octet-stream`. */
export function releaseAssetUrl(
  owner: string,
  repo: string,
  assetId: number,
): string {
  return `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/assets/${assetId}`;
}

/** An asset's metadata is a few hundred bytes of JSON; this bounds a pathological answer. */
const MAX_ASSET_METADATA_BYTES = 64 * 1024;
/** The budget of one metadata read: the headers and the body. */
export const ASSET_METADATA_TIMEOUT_MS = 30_000;

/**
 * One release asset's metadata (`GET /repos/{o}/{r}/releases/assets/{id}`, JSON): its name, size
 * and GitHub's own `digest` of the bytes (HA-08 verifies a mirrored copy against it). `null` on
 * 404 (the asset was deleted), `NotFoundError` on any other refusal or an answer that is not an
 * asset, `UpstreamRateLimitedError` on quota. Bounded by `ASSET_METADATA_TIMEOUT_MS` (a timeout
 * throws, and the caller records it as a failed lookup).
 */
export async function getReleaseAsset(
  token: string,
  owner: string,
  repo: string,
  assetId: number,
  fetchImpl: FetchImpl = fetch,
): Promise<ReleaseAsset | null> {
  const res = await fetchImpl(releaseAssetUrl(owner, repo, assetId), {
    headers: apiHeaders(token, "application/vnd.github+json"),
    redirect: "manual",
    signal: AbortSignal.timeout(ASSET_METADATA_TIMEOUT_MS),
  });
  throwIfRateLimited(res);
  if (res.status === 404) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new NotFoundError(`asset lookup failed: ${res.status}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(
      await readCapped(res, MAX_ASSET_METADATA_BYTES, "asset metadata"),
    );
  } catch (err) {
    if (err instanceof NotFoundError) throw err;
    throw new NotFoundError("asset lookup: not JSON");
  }
  const a = raw as Partial<ReleaseAsset> | null;
  if (
    !a ||
    typeof a !== "object" ||
    a.id !== assetId ||
    typeof a.name !== "string" ||
    !Number.isSafeInteger(a.size) ||
    (a.size as number) < 0
  )
    throw new NotFoundError("asset lookup: unexpected shape");
  return {
    id: a.id,
    name: a.name,
    size: a.size as number,
    content_type: typeof a.content_type === "string" ? a.content_type : "",
    browser_download_url:
      typeof a.browser_download_url === "string" ? a.browser_download_url : "",
    digest: typeof a.digest === "string" ? a.digest : null,
  };
}

/** Fetch a release asset's raw bytes, following (and SSRF-guarding) the storage redirect. */
async function fetchAsset(
  token: string,
  owner: string,
  repo: string,
  assetId: number,
  fetchImpl: FetchImpl,
): Promise<Response> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/releases/assets/${assetId}`;
  let res = await fetchImpl(url, {
    headers: apiHeaders(token, "application/octet-stream"),
    redirect: "manual",
  });
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get("Location");
    if (!loc) throw new NotFoundError("asset redirect: missing location");
    const host = new URL(loc).hostname;
    if (!isAllowedStorageHost(host))
      throw new NotFoundError(`asset redirect host not allowed: ${host}`);
    res = await fetchImpl(loc);
  }
  throwIfRateLimited(res);
  if (!res.ok) throw new NotFoundError(`asset fetch failed: ${res.status}`);
  return res;
}

/**
 * Cap for the sidecar assets read as text (R10-15). A Sparkle EdDSA signature is ~100 bytes
 * and a `shasum`-style `.sha256` line is ~90; 4 KiB is generous for both. A release asset may
 * be 2 GB, and `res.text()` on one of those materialises it as a UTF-16 JS string inside a
 * 128 MB isolate — an OOM that takes co-tenant requests with it, reachable by an
 * unauthenticated `GET /<p>/appcast.xml`.
 */
export const MAX_TEXT_ASSET_BYTES = 4096;

/**
 * Read at most `maxBytes` of a response body as UTF-8, cancelling the stream the moment the
 * cap is passed. The declared `Content-Length` is checked first (cheap rejection), but the
 * streamed accounting is what actually enforces the cap — an absent or lying `Content-Length`
 * must not be able to bypass it.
 *
 * Shared by the sidecar-asset reads (R10-15) and the `.pkey/` manifest reads (R7-02); `what`
 * only names the thing in the error text.
 */
function readCapped(
  res: Response,
  maxBytes: number,
  what = "asset",
): Promise<string> {
  return readCappedText(
    res,
    maxBytes,
    (detail) => new NotFoundError(`${what} too large: ${detail}`),
  );
}

/**
 * Fetch a small text asset (e.g. a `.sig` sidecar) and return its decoded body, bounded by
 * `maxBytes` (R10-15). Over-large sidecars are refused, not truncated: a truncated signature
 * or digest would be a silently wrong value, and callers fail closed on the throw.
 */
export async function fetchTextAsset(
  token: string,
  owner: string,
  repo: string,
  assetId: number,
  fetchImpl: FetchImpl = fetch,
  maxBytes: number = MAX_TEXT_ASSET_BYTES,
): Promise<string> {
  const res = await fetchAsset(token, owner, repo, assetId, fetchImpl);
  return readCapped(res, maxBytes);
}

/**
 * Open a release asset's body as a stream, for signature verification over artifacts of any
 * size (R6-03, P0-10). A declared `Content-Length` over `maxBytes` is refused before a byte is
 * read, and the unread body is cancelled; the consumer must still enforce `maxBytes` while
 * streaming, because an absent or lying `Content-Length` must not be able to bypass the cap.
 * Throws `NotFoundError` for a missing, unfetchable or declared-oversized asset.
 */
export async function fetchAssetStream(
  token: string,
  owner: string,
  repo: string,
  assetId: number,
  maxBytes: number,
  fetchImpl: FetchImpl = fetch,
): Promise<ReadableStream<Uint8Array> | null> {
  const res = await fetchAsset(token, owner, repo, assetId, fetchImpl);
  const declared = Number(res.headers.get("Content-Length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new NotFoundError(`asset too large to verify: ${declared} bytes`);
  }
  return res.body;
}
