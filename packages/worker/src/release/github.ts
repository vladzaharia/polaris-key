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
 * Read a file from a repo via the GitHub Contents API. Returns the decoded UTF-8 text, or
 * `null` on 404 (file/ref absent). `ref` pins a branch/tag/sha; omitted ⇒ default branch.
 * Any other non-OK status maps to a `NotFoundError` so callers stay information-leak-free.
 *
 * The Contents API returns a JSON object whose `content` is base64 (with embedded newlines)
 * when `Accept: application/vnd.github+json`; we decode it here so callers get plain text.
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
  const body = (await res.json()) as { content?: string; encoding?: string };
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
  if (!res.ok) throw new NotFoundError(`asset fetch failed: ${res.status}`);
  return res;
}

/** Fetch a small text asset (e.g. a `.sig` sidecar) and return its decoded body. */
export async function fetchTextAsset(
  token: string,
  owner: string,
  repo: string,
  assetId: number,
  fetchImpl: FetchImpl = fetch,
): Promise<string> {
  return (await fetchAsset(token, owner, repo, assetId, fetchImpl)).text();
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
