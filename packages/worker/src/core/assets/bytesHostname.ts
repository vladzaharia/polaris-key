/**
 * Which host a request arrived on: the bytes host (`BLOB_ORIGIN`, P2-01) or the
 * console host.
 *
 * Its own module because two Core files need the answer and one of them is imported by the
 * other: `bytesHost.ts` (dispatch) and `blobs.ts` (`blobResponse` derives its host from the
 * request rather than trusting a caller, P2-05). `bytesHost.ts` re-exports both functions, so
 * existing importers are unchanged.
 */

import type { Env } from "../../platform/env.js";
import { isAllowedStorageHost } from "../../platform/http.js";

/**
 * A hostname in the form hosts are compared in: lowercase, with any trailing dots removed.
 * `dl.plrs.im.` (the fully-qualified form) is the same DNS name as `dl.plrs.im`, and the edge
 * routes it to this Worker with the dot still in `req.url` — so an exact comparison would let
 * `https://dl.plrs.im./manage` skip host isolation and reach the
 * console-host routes.
 */
export function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.+$/, "");
}

/** The bytes host's hostname (lowercase, no trailing dot), or `null` when `BLOB_ORIGIN` is
 *  unset or unusable. */
export function bytesHostname(env: Pick<Env, "BLOB_ORIGIN">): string | null {
  const origin = env.BLOB_ORIGIN;
  if (typeof origin !== "string" || origin.trim() === "") return null;
  try {
    const u = new URL(origin);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return normalizeHostname(u.hostname) || null;
  } catch {
    return null;
  }
}

/** True when `url` is on the bytes host, in any case and with or without the trailing dot.
 *  Always false with `BLOB_ORIGIN` unset. */
export function isBytesHost(url: URL, env: Pick<Env, "BLOB_ORIGIN">): boolean {
  const host = bytesHostname(env);
  return host !== null && normalizeHostname(url.hostname) === host;
}

/**
 * May a signed-in customer be REDIRECTED to `host` for a download (R6-12)? The GitHub storage
 * hosts `isAllowedStorageHost` names, plus — deliberately, P2b-04 — this deployment's own bytes
 * host, where Distribution serves R2-held bytes. A separate predicate from the SSRF guard's on
 * purpose: "where may the worker FETCH from" stays GitHub-only (`streamAsset`), and only the
 * portal's redirect learns the second host.
 */
export function isAllowedDownloadRedirectHost(
  host: string,
  env: Pick<Env, "BLOB_ORIGIN">,
): boolean {
  if (isAllowedStorageHost(host)) return true;
  const bytes = bytesHostname(env);
  return bytes !== null && normalizeHostname(host) === bytes;
}
