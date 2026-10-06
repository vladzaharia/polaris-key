/**
 * Which host a request arrived on: the image host (`IMG_ORIGIN`, HA-02, notes/S-20 §6.5), and the
 * URLs of the images it serves.
 *
 * Its own module, as `bytesHostname.ts` and `registryHostname.ts` are, so the dispatcher and the
 * consumers that build image URLs (HA-07, HA-12) can share the answer without importing the
 * dispatcher. The comparison is the bytes host's: lowercase, any trailing dots removed, the port
 * ignored (`normalizeHostname`).
 */

import { PRODUCT_SLUG_RE } from "@polaris-key/manifest";
import type { Env } from "../env.js";
import { bytesHostname, normalizeHostname } from "./bytesHostname.js";
import { registryHostname } from "./registryHostname.js";

type ImgEnv = Pick<Env, "IMG_ORIGIN" | "BLOB_ORIGIN" | "PKG_ORIGIN">;

/**
 * The image host's hostname (lowercase, no trailing dot), or `null` when `IMG_ORIGIN` is unset,
 * unusable, or names the bytes host or the registry host. Both are checked first in
 * `dispatch.ts`, so an `IMG_ORIGIN` equal to either could never answer anyway; returning `null`
 * keeps every helper here agreeing with the dispatcher.
 */
export function imgHostname(env: ImgEnv): string | null {
  const origin = env.IMG_ORIGIN;
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
  if (host === bytesHostname(env) || host === registryHostname(env))
    return null;
  return host;
}

/** True when `url` is on the image host, in any case and with or without the trailing dot.
 *  Always false with `IMG_ORIGIN` unset. */
export function isImgHost(url: URL, env: ImgEnv): boolean {
  const host = imgHostname(env);
  return host !== null && normalizeHostname(url.hostname) === host;
}

/** The image host's origin as clients address it (`https://img.plrs.im`), or `null`. */
export function imgOrigin(env: ImgEnv): string | null {
  if (imgHostname(env) === null) return null;
  return new URL(env.IMG_ORIGIN!).origin;
}

const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * The URL of a hosted image on the image host (the hand-off helper HA-07 and HA-12 build URLs
 * with): `https://img.plrs.im/<product>/a/<sha256>` for the original, or
 * `…/<sha256>/<w>.webp` for one of its width variants (HA-03). `null` when there is no image host
 * or an argument is not something the host could ever serve, so a caller never hands out a URL
 * that is certain to 404. Whether THIS product holds the hash is checked when the URL is fetched.
 */
export function imgUrl(
  env: ImgEnv,
  product: string,
  sha256: string,
  w?: number,
): string | null {
  const origin = imgOrigin(env);
  if (origin === null) return null;
  if (!PRODUCT_SLUG_RE.test(product)) return null;
  if (!SHA256_RE.test(sha256)) return null;
  const base = `${origin}/${product}/a/${sha256}`;
  if (w === undefined) return base;
  if (!Number.isSafeInteger(w) || w < 1 || w > IMG_MAX_WIDTH) return null;
  return `${base}/${w}.webp`;
}

/** The widest variant the host addresses. HA-03's ladder tops out at 1920 px. */
export const IMG_MAX_WIDTH = 4096;
