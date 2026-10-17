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
 * `validateRedirectUri` answers the client kind the URI makes. Web is the only kind served today;
 * I-15 widens this one function (loopback, claimed-HTTPS and scheme URIs for `native`) and every
 * caller already carries the answer.
 */

import type { ClientKind } from "@polaris-key/protocol/identity";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import type { SettingsRegistry } from "../../../core/settings/registry.js";
import { resolveProductSetting } from "../../../core/settings/resolve.js";

/** The registry key of the product's allowed callback paths (`settings.ts`). */
export const REDIRECT_PATHS_SETTING = "identity.redirectPaths";

/** The longest redirect URI `authorize` reads. */
export const REDIRECT_URI_MAX_LENGTH = 2048;

export type RedirectUriVerdict =
  | { ok: true; kind: ClientKind; uri: string }
  | { ok: false };

/** What a product registers: its web origins and the paths it allows on them. */
export interface RedirectRegistration {
  webOrigins: readonly string[];
  redirectPaths: readonly string[];
}

/**
 * Is `raw` a redirect URI this product registered? Pure; the one function I-15 widens.
 * Web: `https://<registered origin><registered path>` and nothing else.
 */
export function validateRedirectUri(
  registration: RedirectRegistration,
  raw: unknown,
): RedirectUriVerdict {
  if (
    typeof raw !== "string" ||
    raw === "" ||
    raw.length > REDIRECT_URI_MAX_LENGTH
  )
    return { ok: false };
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
  if (!registration.redirectPaths.includes(url.pathname)) return { ok: false };
  return { ok: true, kind: "web", uri: canonical };
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
