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
 * `/robots.txt`, and the public storefront feeds (`isCustomerFeedRoute`). They are the router's own kinds (`CUSTOMER_ROUTE_KINDS`), so the portal's
 * handlers serve them unchanged; this module only decides what the host may reach.
 *
 * Unset `CUSTOMER_ORIGIN` ⇒ `isCustomerHost` is always false and nothing here runs.
 */

import type { Env } from "../platform/env.js";
import { methodNotAllowed, notFound } from "./errors.js";
import { hostOrigin, usableOrigin, customerSiteOrigin } from "./hosts.js";
import { USER_CODE_ALPHABET } from "./deviceCodeIndex.js";

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
  "deviceApprove",
  // Help (LK-09, D7): `docs` is confined to `customerDocsPath` below, not served whole.
  "docs",
  "helpAlias",
]);

/**
 * The public storefront feeds (Scoop, AltStore, SideStore, AltStore PAL, Obtainium, Flathub,
 * F-Droid): `GET|HEAD /<product>/distribution/<area>/…`, the documents a customer pastes into
 * another app, so the download page names them on this host. They are `service` routes of
 * Distribution, so they are admitted by path SHAPE here (never the whole service): every other
 * Distribution route (the CI plane, hooks, rollouts, the bytes) stays the not-found. They are
 * public, read-only and sessionless; the account cookies are already stripped before a product
 * route runs (`withoutAccountCookies`), and the feed handler sets cookies never. The key host
 * keeps answering the same URLs for existing subscribers.
 */
export function isCustomerFeedRoute(
  route: { kind: string; slug?: string; rest?: readonly string[] },
  method: string,
): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  if (route.kind !== "service" || route.slug !== "distribution") return false;
  const rest = route.rest ?? [];
  switch (rest[0]) {
    case "altstore":
    case "altstore-pal":
      return rest.length === 3 && rest[2] === "source.json";
    case "obtainium":
    case "scoop":
    case "flathub":
      return rest.length === 2;
    case "fdroid":
      return rest.length >= 4 && rest[2] === "repo";
    default:
      return false;
  }
}

/**
 * What of `/docs` the customer host serves: Help and the files a Help page loads (the shared
 * styles and scripts, Help's own search bundle (Help pages only), the site's own 404, the branding). Every other
 * `/docs` path redirects to the console host (`docsElsewhere`). All of them are public tier, so
 * no session is read here.
 */
const CUSTOMER_DOCS_PREFIXES: readonly string[] = [
  "/docs/help/",
  "/docs/_astro/",
  "/docs/pagefind-help/",
  "/docs/branding/",
];
const CUSTOMER_DOCS_FILES: ReadonlySet<string> = new Set([
  "/docs/help",
  "/docs/404.html",
  "/docs/sitemap-help.xml",
]);

/** True when the customer host serves this `/docs` path itself. */
export function customerDocsPath(pathname: string): boolean {
  return (
    CUSTOMER_DOCS_FILES.has(pathname) ||
    CUSTOMER_DOCS_PREFIXES.some((p) => pathname.startsWith(p))
  );
}

/** A `/docs` path the customer host does not serve: a redirect to the same path on the console host. */
export function docsElsewhere(req: Request, env: Env, url: URL): Response {
  if (req.method !== "GET" && req.method !== "HEAD") return notFound();
  const origin = apiOrigin(env);
  if (origin === null) return notFound();
  return new Response(null, {
    status: 302,
    headers: {
      location: `${origin}${url.pathname}${url.search}`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

/**
 * `/help[/*]`: the short link to Help. On the customer host it stays on the host; on the console
 * host it goes straight to the customer host once that is usable (no double hop), else to the
 * console host's own Help.
 */
export function helpAliasResponse(
  req: Request,
  env: Env,
  url: URL,
  onCustomerHost: boolean,
): Response {
  if (req.method !== "GET" && req.method !== "HEAD")
    return new Response(null, {
      status: 405,
      headers: { allow: "GET, HEAD", "cache-control": "no-store" },
    });
  const origin = onCustomerHost ? "" : (hostOrigin("customer", env) ?? "");
  return new Response(null, {
    status: 302,
    headers: {
      location: `${origin}/docs/help/${url.pathname.slice("/help/".length)}${url.search}`,
      "cache-control": "no-store",
    },
  });
}

/**
 * `polaris.locker/<slug>` (LK-12, plans/LK-00.md §7.1): the destination of the "Available on" and
 * "Open in" Polaris Locker badges. It answers a redirect to the product's storefront page in the
 * customer site (`/#/discover/<slug>`); the SPA shows its one not-found for a product that is
 * unknown, unlisted or withdrawn (S-21 D5), so this answers the same for every well-formed slug
 * and reads no database: it is no oracle for which products exist. The target is built from the
 * matched slug alone (`[a-z0-9-]`, never a reserved platform slug), never from the request's
 * host, query or fragment. The caller lower-cases the slug and accepts a trailing slash. Only GET
 * and HEAD; `null` for any other route.
 */
export function customerSlugRedirect(
  req: Request,
  route: {
    kind: string;
    slug?: string;
    product?: string;
    rest?: readonly string[];
  },
): Response | null {
  if (
    route.kind !== "service" ||
    route.slug !== "distribution" ||
    route.rest?.length !== 1 ||
    route.rest[0] !== "download" ||
    typeof route.product !== "string"
  )
    return null;
  if (req.method !== "GET" && req.method !== "HEAD") return null;
  return new Response(null, {
    status: 302,
    headers: {
      location: `/#/discover/${route.product}`,
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
    },
  });
}

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
    // Help (/docs/help/, public) is the crawlable part of the host; its redirect pages are noindex
    // and the sign-in and API paths are off limits. Every other /docs path redirects to the console
    // host, so nothing gated is named here. The sitemap is this host's own (Help only).
    const origin = new URL(req.url).origin;
    const body = [
      "User-agent: *",
      "Allow: /docs/help/",
      "Allow: /docs/_astro/",
      "Disallow: /docs/help/code/",
      "Disallow: /api/",
      "Disallow: /login",
      "Disallow: /callback",
      `Sitemap: ${origin}/docs/sitemap-help.xml`,
      "",
    ].join("\n");
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
 * bundle). `/` and `/index.html` are the console's own redirect (LK-14). Permanent (301) for the pages; temporary
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
      if (path !== "/activate") return null;
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
    // Help moved to the customer host (LK-09, D7): `/docs/help/*` and the pages it loads.
    case "docs":
      if (path !== "/docs/help" && !path.startsWith("/docs/help/")) return null;
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
  const target = `${origin}${path}${url.search}`;
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

/** The device code in its display form (`BCDF-GHJK`): exactly this, nothing looser. */
const APPROVE_CODE = new RegExp(
  `^[${USER_CODE_ALPHABET}]{4}-[${USER_CODE_ALPHABET}]{4}$`,
);

/**
 * F-37.1b: the key host's hops into Polaris Locker, for links a terminal prints. `/approve?code=`
 * (the approval a `pkey` packages sign-in sends the person to) and `/account/packages` answer a 302
 * to the portal's hash route. The portal is the customer origin when `CUSTOMER_ORIGIN` is usable,
 * else this host's own portal (its `/` is still the portal then). The target origin is fixed
 * configuration (or the request's own origin); the only request data in the `Location` is a code
 * that matched the exact display form above, percent-encoded, so there is no open redirect. Any
 * other code is a 400 and nothing is echoed. The code rides in the fragment so the portal's
 * access logs never see it.
 */
export function lockerLink(
  req: Request,
  env: Env,
  to: "approve" | "packages",
  url: URL,
): Response {
  if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed();
  const base = customerSiteOrigin(env) ?? url.origin;
  let hash: string;
  if (to === "approve") {
    const code = url.searchParams.get("code");
    if (code === null || !APPROVE_CODE.test(code))
      return new Response("Bad Request", {
        status: 400,
        headers: { "cache-control": "no-store" },
      });
    hash = `/account/approve?code=${encodeURIComponent(code)}`;
  } else hash = "/account/packages";
  return new Response(null, {
    status: 302,
    headers: {
      location: `${base}/#${hash}`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}
