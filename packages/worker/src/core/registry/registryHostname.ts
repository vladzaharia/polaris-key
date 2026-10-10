/**
 * Which host a request arrived on: the registry host (`PKG_ORIGIN`, F-02, plans/F-01.md §6.1).
 *
 * Its own module, as `bytesHostname.ts` is, so the dispatcher and the landing page can share
 * the answer without importing each other. The comparison is the bytes host's: lowercase, any
 * trailing dots removed, the port ignored (`normalizeHostname`).
 */

import type { Env } from "../../platform/env.js";
import { bytesHostname, normalizeHostname } from "../assets/bytesHostname.js";

/**
 * The registry host's hostname (lowercase, no trailing dot), or `null` when `PKG_ORIGIN` is
 * unset, unusable, or names the bytes host. The bytes host is checked first in `dispatch.ts`,
 * so a `PKG_ORIGIN` equal to `BLOB_ORIGIN` could never answer anyway; returning `null` keeps
 * every helper here agreeing with the dispatcher.
 */
export function registryHostname(
  env: Pick<Env, "PKG_ORIGIN" | "BLOB_ORIGIN">,
): string | null {
  const origin = env.PKG_ORIGIN;
  if (typeof origin !== "string" || origin.trim() === "") return null;
  let host: string;
  try {
    const u = new URL(origin);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    host = normalizeHostname(u.hostname);
  } catch {
    return null;
  }
  if (!host) return null;
  return host === bytesHostname(env) ? null : host;
}

/** True when `url` is on the registry host, in any case and with or without the trailing dot.
 *  Always false with `PKG_ORIGIN` unset. */
export function isRegistryHost(
  url: URL,
  env: Pick<Env, "PKG_ORIGIN" | "BLOB_ORIGIN">,
): boolean {
  const host = registryHostname(env);
  return host !== null && normalizeHostname(url.hostname) === host;
}

/** The registry host's origin as clients must address it (`https://pkg.plrs.im`), or `null`.
 *  Renderers build absolute URLs (npm `dist.tarball`) from it. */
export function registryOrigin(
  env: Pick<Env, "PKG_ORIGIN" | "BLOB_ORIGIN">,
): string | null {
  if (registryHostname(env) === null) return null;
  return new URL(env.PKG_ORIGIN!).origin;
}
