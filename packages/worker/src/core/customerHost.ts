/// <reference types="@cloudflare/workers-types" />
/**
 * Host isolation for the customer host (LK-03, plans/LK-00.md §7.1): `CUSTOMER_ORIGIN`, e.g.
 * `https://polaris.locker`, is the same Worker on one more custom domain, beside the console, the
 * bytes host, the registry host and the image host. A request that arrives here reaches ONLY the
 * customer routes; `/manage`, `/docs` (but for Help, D7), every product route and every webhook
 * answer the plain not-found.
 *
 * The routes are the root portal's and the platform entry pages: `/`, `/index.html`, `/activate`,
 * `/assets/*` (one admin build; the console bundle is public code, useless without a console
 * session), `/signin`, `/device`, `/tv`, `/login[/…]`, `/callback`, `/logout`, `/magic/verify`,
 * `/api/*`, `/media/*`, `/download/<token>`, plus two answers of the host's own:
 * `/.well-known/polaris-host.json` (the health check the console's switch reads) and
 * `/robots.txt`. They are the router's own kinds (`CUSTOMER_ROUTE_KINDS`), so the portal's
 * handlers serve them unchanged; this module only decides what the host may reach.
 *
 * Unset `CUSTOMER_ORIGIN` ⇒ `isCustomerHost` is always false and nothing here runs.
 */

import type { Env } from "../platform/env.js";
import { methodNotAllowed, notFound } from "./errors.js";
import { hostOrigin, usableOrigin } from "./hosts.js";

/** The route kinds the customer host serves: the root portal and the platform entry pages. */
export const CUSTOMER_ROUTE_KINDS: ReadonlySet<string> = new Set([
  "portalSpa",
  "portalApi",
  "portalLogin",
  "portalProviderSignIn",
  "portalCallback",
  "portalLogout",
  "portalMagicVerify",
  "portalDownload",
  "portalMedia",
  "signInEntry",
  "deviceEntry",
]);

export const HOST_DOCUMENT_PATH = "/.well-known/polaris-host.json";
export const ROBOTS_PATH = "/robots.txt";

/** The paths the host answers itself (no route kind, no session, no database). */
export function isCustomerHostOwnPath(pathname: string): boolean {
  return pathname === HOST_DOCUMENT_PATH || pathname === ROBOTS_PATH;
}

/**
 * The host's own answers. `polaris-host.json` is the health check the console reads before it
 * checks (LK-11's smoke): `{host: "customer"}`. CORS for the console origin only, without
 * credentials. `robots.txt` keeps crawlers off the sign-in and API paths.
 */
export function customerHostOwnResponse(
  req: Request,
  env: Env,
  pathname: string,
): Response {
  if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed();
  if (pathname === ROBOTS_PATH) {
    const body =
      "User-agent: *\nDisallow: /api/\nDisallow: /login\nDisallow: /callback\n";
    return new Response(req.method === "HEAD" ? null : body, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "public, max-age=300",
        "x-content-type-options": "nosniff",
      },
    });
  }
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    vary: "origin",
  });
  const consoleOrigin = usableOrigin(env.CONSOLE_ORIGIN?.trim() ?? "");
  if (consoleOrigin) headers.set("access-control-allow-origin", consoleOrigin);
  return new Response(
    req.method === "HEAD" ? null : JSON.stringify({ host: "customer" }),
    { headers },
  );
}

/**
 * The old customer URLs on the console host (LK-17, the hard cutover): once `CUSTOMER_ORIGIN` is
 * usable, a GET or HEAD to a customer page on the console host answers a redirect to the same path
 * and query on the customer origin, so every link already out keeps working. `/signin?request=`
 * stays (the cross-host bind hop, LK-04) and so do `/api/*`, `/media/*` and `/assets/*` (the console
 * bundle). `/` is the console's own redirect (LK-14). Permanent (301) for the pages; temporary
 * (302, no-store) for a path that carries a credential: a sign-in callback, a magic-link token,
 * a download token, a legacy `/activate?key=`. `null` when the request is not an old customer URL.
 * Rollback is removing `CUSTOMER_ORIGIN`: a browser keeps a 301 it has seen (docs/RUNBOOK.md).
 */
export function oldCustomerUrlRedirect(
  req: Request,
  env: Env,
  route: { kind: string },
  url: URL,
): Response | null {
  if (req.method !== "GET" && req.method !== "HEAD") return null;
  const origin = hostOrigin("customer", env);
  if (origin === null) return null;
  const path = url.pathname;
  let permanent: boolean;
  switch (route.kind) {
    case "portalSpa":
      if (path !== "/activate" && path !== "/index.html") return null;
      permanent = !url.searchParams.has("key");
      break;
    case "signInEntry":
      if (url.searchParams.has("request")) return null;
      permanent = true;
      break;
    case "deviceEntry":
      permanent = true;
      break;
    case "portalLogin":
      permanent = true;
      break;
    case "portalProviderSignIn":
    case "portalCallback":
    case "portalLogout":
    case "portalMagicVerify":
    case "portalDownload":
      permanent = false;
      break;
    default:
      return null;
  }
  const target = `${origin}${path === "/index.html" ? "/" : path}${url.search}`;
  const headers = new Headers({
    location: target,
    "x-content-type-options": "nosniff",
  });
  if (!permanent) headers.set("cache-control", "no-store");
  return new Response(null, { status: permanent ? 301 : 302, headers });
}

/**
 * The API host's origin (`CONSOLE_ORIGIN`): where the customer host sends a person to a product's
 * own page (the device confirmation) until that page moves (LK-04). From configuration, never from
 * the request; `null` when it is unset or unusable.
 */
export function apiOrigin(env: Pick<Env, "CONSOLE_ORIGIN">): string | null {
  return usableOrigin(env.CONSOLE_ORIGIN?.trim() ?? "");
}

/**
 * WebAuthn Related Origin Requests (LK-05, plans/LK-00.md §7.7): the passkey RP id stays the
 * console host, and `GET /.well-known/webauthn` on it lists the customer origin so a browser lets
 * a ceremony on `polaris.locker` use that RP id. Built from `CUSTOMER_ORIGIN` alone, never from
 * stored data, and only while the customer host is usable. `null` otherwise.
 */
export function relatedOrigins(env: Env): string[] | null {
  const origin = hostOrigin("customer", env);
  return origin === null ? null : [origin];
}

/** The well-known answer: the list, or the plain not-found while there is no usable customer host. */
export function relatedOriginsResponse(req: Request, env: Env): Response {
  if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed();
  const origins = relatedOrigins(env);
  if (origins === null) return notFound();
  return new Response(
    req.method === "HEAD" ? null : JSON.stringify({ origins }),
    {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=300",
        "x-content-type-options": "nosniff",
      },
    },
  );
}
