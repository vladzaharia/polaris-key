/**
 * The redirect URI rule of `authorize` (WIRE-CONTRACT-V4 §12.4; plans/I-27.md §2.1, I-04 §2.5).
 *
 * A web app's redirect URI is one of the product's registered `web.origins` plus one of its
 * `identity.redirectPaths`, both matched EXACTLY: no wildcard, no prefix, no suffix, no query, no
 * fragment, no userinfo, no dot segment and no second spelling of the same URI. The URI the app
 * sent must equal the canonical form the platform builds from the parsed origin and path, so a
 * URI the URL parser would rewrite (`/a/../cb`, `%2e`, a trailing `?`, a backslash) is refused
 * rather than normalised into one that matches.
 *
 * `validateRedirectUri` answers the client kind and class the URI makes. The native classes
 * (loopback, registered scheme, claimed HTTPS; §12.12) are accepted only for a caller that asks for
 * them, which is the pushed `request` and never a direct `authorize`.
 */

import type {
  ClientKind,
  NativeRedirectClass,
} from "@polaris-key/protocol/identity";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import type { SettingsRegistry } from "../../../core/settings/registry.js";
import { resolveProductSetting } from "../../../core/settings/resolve.js";

/** The registry key of the product's allowed callback paths (`settings.ts`). */
export const REDIRECT_PATHS_SETTING = "identity.redirectPaths";

/** The longest redirect URI `authorize` reads. */
export const REDIRECT_URI_MAX_LENGTH = 2048;

/** The class of a redirect URI: `web` is the browser redirect, the others are native (§12.12). */
export type RedirectClass = "web" | NativeRedirectClass;

export type RedirectUriVerdict =
  | { ok: true; kind: ClientKind; redirect: RedirectClass; uri: string }
  | { ok: false };

/** What a product registers: its web origins and the paths it allows on them. */
export interface RedirectRegistration {
  webOrigins: readonly string[];
  redirectPaths: readonly string[];
  /** `identity.nativeRedirect.loopback`; absent reads as the default, on. */
  loopback?: boolean;
  /** `identity.nativeRedirect.schemes`. */
  schemes?: readonly string[];
  /** `identity.nativeRedirect.claimedPaths`. */
  claimedPaths?: readonly string[];
}

/** Which classes a caller accepts: `authorize` takes web only, the pushed `request` native only. */
export type RedirectAccept = "web" | "native";

const LOOPBACK_RE =
  /^http:\/\/(?:127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})\/pkey\/callback$/;
const SCHEME_URI_RE = /^([a-z][a-z0-9+.-]*):\/pkey\/callback$/;

/**
 * Is `raw` a redirect URI this product registered, in a class the caller accepts? Pure.
 *
 * - `web` (`accept: "web"`, the default): `https://<registered origin><registered path>`.
 * - `native` (WIRE-CONTRACT-V5 §12.12): loopback (`http://127.0.0.1:<port>/pkey/callback` or the
 *   `[::1]` literal, any explicit port but 80, while `loopback` is not off), a registered
 *   `<scheme>:/pkey/callback`, or a claimed `https://<web origin><claimed path>`.
 *
 * A native URI on a web-only caller, and a web URI on a native-only caller, are refused. Every
 * class is an exact match of the spelling the platform builds.
 */
export function validateRedirectUri(
  registration: RedirectRegistration,
  raw: unknown,
  accept: RedirectAccept = "web",
): RedirectUriVerdict {
  if (
    typeof raw !== "string" ||
    raw === "" ||
    raw.length > REDIRECT_URI_MAX_LENGTH
  )
    return { ok: false };
  if (accept === "native") {
    const lb = LOOPBACK_RE.exec(raw);
    if (lb) {
      const port = Number(lb[1]);
      if (port > 65535 || port === 80 || registration.loopback === false)
        return { ok: false };
      return { ok: true, kind: "native", redirect: "loopback", uri: raw };
    }
    const sc = SCHEME_URI_RE.exec(raw);
    if (sc) {
      return registration.schemes?.includes(sc[1]!)
        ? { ok: true, kind: "native", redirect: "scheme", uri: raw }
        : { ok: false };
    }
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false };
  }
  if (url.username !== "" || url.password !== "") return { ok: false };
  if (url.search !== "" || url.hash !== "") return { ok: false };
  const canonical = `${url.origin}${url.pathname}`;
  // The parser's rewrite is never trusted: the app must have sent the canonical spelling.
  if (raw !== canonical) return { ok: false };
  if (!registration.webOrigins.includes(url.origin)) return { ok: false };
  if (accept === "web") {
    return registration.redirectPaths.includes(url.pathname)
      ? { ok: true, kind: "web", redirect: "web", uri: canonical }
      : { ok: false };
  }
  // Claimed paths never overlap the web paths (the manifest refuses it), but a web path still wins
  // no claim here: a native caller reaches only a claimed path.
  if (
    url.protocol === "https:" &&
    registration.claimedPaths?.includes(url.pathname) &&
    !registration.redirectPaths.includes(url.pathname)
  )
    return { ok: true, kind: "native", redirect: "claimed", uri: canonical };
  return { ok: false };
}

/**
 * The product's `identity.redirectPaths`, resolved (manifest or console claim). A drifted value, a
 * missing registry (a context built by hand) and an unknown product all read as no paths, which
 * refuses every redirect URI (fail closed).
 */
export async function redirectPathsOf(
  ctx: { env: Env; db: Db; registry?: SettingsRegistry },
  product: string,
): Promise<string[]> {
  if (!ctx.registry?.get(REDIRECT_PATHS_SETTING, "product")) return [];
  const r = await resolveProductSetting(
    { env: ctx.env, db: ctx.db, registry: ctx.registry },
    product,
    REDIRECT_PATHS_SETTING,
  );
  const v = r?.value;
  return Array.isArray(v)
    ? v.filter((p): p is string => typeof p === "string")
    : [];
}

/** The registry keys of the native redirect classes (`settings.ts`). */
export const NATIVE_LOOPBACK_SETTING = "identity.nativeRedirect.loopback";
export const NATIVE_SCHEMES_SETTING = "identity.nativeRedirect.schemes";
export const NATIVE_CLAIMED_PATHS_SETTING =
  "identity.nativeRedirect.claimedPaths";

/**
 * The product's whole redirect registration, resolved (manifest or console claim). A drifted
 * value or a missing registry reads as the safe side: no paths, no schemes, loopback at its
 * default (on).
 */
export async function redirectRegistrationOf(
  ctx: { env: Env; db: Db; registry?: SettingsRegistry },
  product: { slug: string; webOrigins: readonly string[] },
): Promise<RedirectRegistration> {
  const strings = async (key: string): Promise<string[]> => {
    if (!ctx.registry?.get(key, "product")) return [];
    const r = await resolveProductSetting(
      { env: ctx.env, db: ctx.db, registry: ctx.registry },
      product.slug,
      key,
    );
    return Array.isArray(r?.value)
      ? r.value.filter((p): p is string => typeof p === "string")
      : [];
  };
  let loopback = true;
  if (ctx.registry?.get(NATIVE_LOOPBACK_SETTING, "product")) {
    const r = await resolveProductSetting(
      { env: ctx.env, db: ctx.db, registry: ctx.registry },
      product.slug,
      NATIVE_LOOPBACK_SETTING,
    );
    if (r?.value === false) loopback = false;
  }
  return {
    webOrigins: product.webOrigins,
    redirectPaths: await redirectPathsOf(ctx, product.slug),
    loopback,
    schemes: await strings(NATIVE_SCHEMES_SETTING),
    claimedPaths: await strings(NATIVE_CLAIMED_PATHS_SETTING),
  };
}
