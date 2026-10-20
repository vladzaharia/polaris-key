/**
 * The auxiliary hosts, in one table (P0-22): which hostname a request arrived on, and the origin a
 * renderer builds absolute URLs from. Three modules used to carry three copies of one function.
 *
 *   bytes     `BLOB_ORIGIN`  the content-addressed bytes host (P2-01)
 *   registry  `PKG_ORIGIN`   the package-registry host (F-02)
 *   img       `IMG_ORIGIN`   the hosted-image host (HA-02)
 *   customer  `CUSTOMER_ORIGIN`  the customer site, Polaris Locker (LK-03)
 *
 * A host's name is lowercase with trailing dots removed, and the port is ignored. The kinds are
 * listed in precedence order: a host whose origin names an EARLIER kind's hostname answers `null`,
 * because `dispatch.ts` tests the kinds in this order and the earlier one would win anyway.
 * Returning `null` keeps every helper agreeing with the dispatcher.
 *
 * It lives at the root of `core/` because the dispatcher, the landing pages and the blob store all
 * need the answer and several of them import each other.
 */

import { PRODUCT_SLUG_RE } from "@polaris-key/manifest";
import type { Env } from "../platform/env.js";
import { isAllowedStorageHost } from "../platform/http.js";

/** The env members the table reads. */
export type HostsEnv = Pick<
  Env,
  | "BLOB_ORIGIN"
  | "PKG_ORIGIN"
  | "IMG_ORIGIN"
  | "CUSTOMER_ORIGIN"
  | "CONSOLE_ORIGIN"
>;

/** One auxiliary host kind. */
export type HostKind = "bytes" | "registry" | "img" | "customer";

/** The kinds and the env variable that names each, in precedence order. */
export const HOSTS: readonly { kind: HostKind; origin: keyof HostsEnv }[] = [
  { kind: "bytes", origin: "BLOB_ORIGIN" },
  { kind: "registry", origin: "PKG_ORIGIN" },
  { kind: "img", origin: "IMG_ORIGIN" },
  { kind: "customer", origin: "CUSTOMER_ORIGIN" },
];

/**
 * A hostname in the form hosts are compared in: lowercase, with any trailing dots removed.
 * `dl.plrs.im.` (the fully-qualified form) is the same DNS name as `dl.plrs.im`, and the edge
 * routes it to this Worker with the dot still in `req.url` — so an exact comparison would let
 * `https://dl.plrs.im./manage` skip host isolation and reach the console-host routes.
 */
export function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.+$/, "");
}

/** The normalised hostname an origin names, or `null` when it is unset or not an http(s) URL. */
function hostOf(origin: unknown): string | null {
  if (typeof origin !== "string" || origin.trim() === "") return null;
  try {
    const u = new URL(origin);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return normalizeHostname(u.hostname) || null;
  } catch {
    return null;
  }
}

/** The hostname of `kind` (lowercase, no trailing dot), or `null` when its origin is unset,
 *  unusable, or names an earlier kind's hostname. */
export function hostname(kind: HostKind, env: HostsEnv): string | null {
  const at = HOSTS.findIndex((h) => h.kind === kind);
  const own = hostOf(env[HOSTS[at]!.origin]);
  if (own === null) return null;
  // The customer host is a second host for the SAME Worker, never the console's own: naming the
  // console host would confine the console to customer routes (LK-03).
  if (kind === "customer") {
    // Usable means a bare https (or loopback http) origin, and only with a usable console origin
    // beside it: without one a misconfigured deploy could confine the console, and the customer
    // host's hand-off to the API host would have no origin to name.
    if (
      hostOf(env.CONSOLE_ORIGIN) === null ||
      hostOf(env.CONSOLE_ORIGIN) === own
    )
      return null;
    const raw = env.CUSTOMER_ORIGIN!.trim();
    const u = new URL(raw);
    if (
      usableOrigin(raw) === null ||
      u.pathname !== "/" ||
      u.search !== "" ||
      u.hash !== ""
    )
      return null;
  }
  for (const earlier of HOSTS.slice(0, at))
    if (hostname(earlier.kind, env) === own) return null;
  return own;
}

/** True when `url` is on the `kind` host, in any case and with or without the trailing dot.
 *  Always false with that origin unset. */
export function isHost(kind: HostKind, url: URL, env: HostsEnv): boolean {
  const host = hostname(kind, env);
  return host !== null && normalizeHostname(url.hostname) === host;
}

/** The `kind` host's origin as clients address it (`https://img.plrs.im`), or `null`. */
export function hostOrigin(kind: HostKind, env: HostsEnv): string | null {
  if (hostname(kind, env) === null) return null;
  const origin = env[HOSTS.find((h) => h.kind === kind)!.origin];
  return new URL(origin!).origin;
}

// ── The customer host (LK-03) ──────────────────────────────────────────────────────────────────

export const customerHostname = (env: HostsEnv): string | null =>
  hostname("customer", env);
export const isCustomerHost = (url: URL, env: HostsEnv): boolean =>
  isHost("customer", url, env);

/**
 * `raw` as an origin a link may be built on: `https:` (or `http:` to a loopback host, for local
 * development), no credentials. `null` otherwise.
 */
export function usableOrigin(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.username !== "" || u.password !== "") return null;
    if (u.protocol === "https:") return u.origin;
    if (
      u.protocol === "http:" &&
      (u.hostname === "localhost" || u.hostname === "127.0.0.1")
    )
      return u.origin;
    return null;
  } catch {
    return null;
  }
}

/**
 * The console origin of old: `CONSOLE_ORIGIN` when usable, else the origin of `fallback` (the
 * request, or an absolute URL the Worker was reached on). The passkey RP id stays here (LK-05).
 */
export function consoleOrigin(
  env: HostsEnv,
  fallback: Request | string,
): string | null {
  const console =
    typeof env.CONSOLE_ORIGIN === "string" && env.CONSOLE_ORIGIN.trim() !== ""
      ? usableOrigin(env.CONSOLE_ORIGIN.trim())
      : null;
  return (
    console ??
    usableOrigin(typeof fallback === "string" ? fallback : fallback.url)
  );
}

/**
 * The ONE source for every customer-facing URL (LK-00 §7.2): `CUSTOMER_ORIGIN` when the host is
 * usable (LK-17: that is the whole switch, there is no setting), else {@link consoleOrigin}.
 */
export function customerOrigin(
  env: HostsEnv,
  fallback: Request | string,
): string | null {
  const own = usableOrigin(env.CUSTOMER_ORIGIN ?? "");
  if (own !== null && hostname("customer", env) !== null) return own;
  return consoleOrigin(env, fallback);
}

// ── The named forms the callers read ───────────────────────────────────────────────────────────

export const bytesHostname = (env: Pick<Env, "BLOB_ORIGIN">): string | null =>
  hostname("bytes", env);
export const isBytesHost = (url: URL, env: Pick<Env, "BLOB_ORIGIN">): boolean =>
  isHost("bytes", url, env);

export const registryHostname = (
  env: Pick<Env, "PKG_ORIGIN" | "BLOB_ORIGIN">,
): string | null => hostname("registry", env);
export const isRegistryHost = (
  url: URL,
  env: Pick<Env, "PKG_ORIGIN" | "BLOB_ORIGIN">,
): boolean => isHost("registry", url, env);
export const registryOrigin = (
  env: Pick<Env, "PKG_ORIGIN" | "BLOB_ORIGIN">,
): string | null => hostOrigin("registry", env);

export const imgHostname = (env: HostsEnv): string | null =>
  hostname("img", env);
export const isImgHost = (url: URL, env: HostsEnv): boolean =>
  isHost("img", url, env);
export const imgOrigin = (env: HostsEnv): string | null =>
  hostOrigin("img", env);

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

const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * The URL of a hosted image on the image host (the hand-off helper HA-07 and HA-12 build URLs
 * with): `https://img.plrs.im/<product>/a/<sha256>` for the original, or
 * `…/<sha256>/<w>.webp` for one of its width variants (HA-03). `null` when there is no image host
 * or an argument is not something the host could ever serve, so a caller never hands out a URL
 * that is certain to 404. Whether THIS product holds the hash is checked when the URL is fetched.
 */
export function imgUrl(
  env: HostsEnv,
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
