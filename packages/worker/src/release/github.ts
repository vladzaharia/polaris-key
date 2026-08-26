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
import { MAX_MANIFEST_BYTES } from "./manifest.js";

const GITHUB_API = "https://api.github.com";
const USER_AGENT = "polaris-key-release";

export interface ReleaseAsset {
  id: number;
  name: string;
  size: number;
  content_type: string;
  browser_download_url: string;
}

export interface Release {
  tag_name: string;
  name: string | null;
  body: string | null;
  published_at: string | null;
  html_url: string;
  prerelease: boolean;
  draft: boolean;
  assets: ReleaseAsset[];
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
 * Resolve a release by version. `latest`/undefined hits `/releases/latest`; anything
 * else is treated as a semver tag and resolved via `/releases/tags/v<version>`.
 */
export async function resolveRelease(
  token: string,
  owner: string,
  repo: string,
  version: string | undefined,
  fetchImpl: FetchImpl = fetch,
): Promise<Release> {
  const base = `${GITHUB_API}/repos/${owner}/${repo}/releases`;
  const url =
    !version || version === "latest"
      ? `${base}/latest`
      : `${base}/tags/v${encodeURIComponent(version)}`;
  const res = await fetchImpl(url, {
    headers: apiHeaders(token, "application/vnd.github+json"),
  });
  throwIfRateLimited(res);
  if (!res.ok) throw new NotFoundError(`release lookup failed: ${res.status}`);
  return (await res.json()) as Release;
}

/** List published releases (newest first), for changelog + channel derivation. */
export async function listReleases(
  token: string,
  owner: string,
  repo: string,
  perPage = 100,
  fetchImpl: FetchImpl = fetch,
): Promise<Release[]> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/releases?per_page=${perPage}`;
  const res = await fetchImpl(url, {
    headers: apiHeaders(token, "application/vnd.github+json"),
  });
  throwIfRateLimited(res);
  if (!res.ok) throw new NotFoundError(`releases list failed: ${res.status}`);
  return (await res.json()) as Release[];
}

/** True for GitHub release-asset storage hosts the SSRF guard permits re-fetching. */
function isAllowedStorageHost(host: string): boolean {
  return (
    host === "github.com" ||
    host === "githubusercontent.com" ||
    host.endsWith(".githubusercontent.com")
  );
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
 */
export async function streamAsset(
  token: string,
  owner: string,
  repo: string,
  assetId: number,
  clientRequest: Request,
  opts: StreamAssetOptions,
  fetchImpl: FetchImpl = fetch,
): Promise<Response> {
  const headers = new Headers(apiHeaders(token, "application/octet-stream"));
  const range = clientRequest.headers.get("Range");
  if (range) headers.set("Range", range);
  const ifNoneMatch = clientRequest.headers.get("If-None-Match");
  if (ifNoneMatch) headers.set("If-None-Match", ifNoneMatch);

  const url = `${GITHUB_API}/repos/${owner}/${repo}/releases/assets/${assetId}`;
  let upstream = await fetchImpl(url, { headers, redirect: "manual" });

  if (upstream.status >= 300 && upstream.status < 400) {
    const loc = upstream.headers.get("Location");
    if (!loc) throw new NotFoundError("asset redirect: missing location");
    // SSRF guard: only follow redirects into GitHub's own storage hosts.
    const host = new URL(loc).hostname;
    if (!isAllowedStorageHost(host))
      throw new NotFoundError(`asset redirect host not allowed: ${host}`);
    const storageHeaders = new Headers();
    if (range) storageHeaders.set("Range", range);
    if (ifNoneMatch) storageHeaders.set("If-None-Match", ifNoneMatch);
    upstream = await fetchImpl(loc, { headers: storageHeaders }); // signed URL — no Authorization
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
async function readCapped(
  res: Response,
  maxBytes: number,
  what = "asset",
): Promise<string> {
  const declared = Number(res.headers.get("Content-Length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new NotFoundError(`${what} too large: ${declared} bytes`);
  }
  const body = res.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new NotFoundError(`${what} too large: >${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(buf);
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
 * Fetch a release asset's raw bytes into memory, for signature verification (R6-03).
 * `maxBytes` bounds the read so a huge artifact can't blow the isolate's memory budget.
 */
export async function fetchAssetBytes(
  token: string,
  owner: string,
  repo: string,
  assetId: number,
  maxBytes: number,
  fetchImpl: FetchImpl = fetch,
): Promise<Uint8Array> {
  const res = await fetchAsset(token, owner, repo, assetId, fetchImpl);
  const declared = Number(res.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new NotFoundError(`asset too large to verify: ${declared} bytes`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > maxBytes) {
    throw new NotFoundError(`asset too large to verify: ${buf.byteLength}`);
  }
  return buf;
}
