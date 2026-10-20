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
import { methodNotAllowed } from "./errors.js";
import { usableOrigin, type CustomerHostMode } from "./hosts.js";
import { deployIdentity } from "./ops/deployIdentity.js";

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

const ENVIRONMENTS = ["prod", "staging", "dev"];

/** The paths the host answers itself (no route kind, no session, no database). */
export function isCustomerHostOwnPath(pathname: string): boolean {
  return pathname === HOST_DOCUMENT_PATH || pathname === ROBOTS_PATH;
}

/**
 * The host's own answers. `polaris-host.json` is the health check the console reads before it
 * turns `customer.host` on: `{host: "customer", environment, version}`, matching `/manage/api/me`'s
 * `environment`. CORS for the console origin only, without credentials. `robots.txt` disallows
 * everything while the switch is `off` (the host is up, but nothing points at it yet).
 */
export function customerHostOwnResponse(
  req: Request,
  env: Env,
  pathname: string,
  mode: CustomerHostMode,
): Response {
  if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed();
  if (pathname === ROBOTS_PATH) {
    const body =
      mode === "off"
        ? "User-agent: *\nDisallow: /\n"
        : "User-agent: *\nDisallow: /api/\nDisallow: /login\nDisallow: /callback\n";
    return new Response(req.method === "HEAD" ? null : body, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "public, max-age=300",
        "x-content-type-options": "nosniff",
      },
    });
  }
  const environment = env.PKEY_ENVIRONMENT?.trim().toLowerCase() ?? "";
  const id = deployIdentity(env);
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    vary: "origin",
  });
  const consoleOrigin = usableOrigin(env.CONSOLE_ORIGIN?.trim() ?? "");
  if (consoleOrigin) headers.set("access-control-allow-origin", consoleOrigin);
  return new Response(
    req.method === "HEAD"
      ? null
      : JSON.stringify({
          host: "customer",
          environment: ENVIRONMENTS.includes(environment) ? environment : null,
          version: id.gitSha ?? id.releaseTag ?? id.cloudflare?.id ?? null,
        }),
    { headers },
  );
}

/**
 * The API host's origin (`CONSOLE_ORIGIN`): where the customer host sends a person to a product's
 * own page (the device confirmation) until that page moves (LK-04). From configuration, never from
 * the request; `null` when it is unset or unusable.
 */
export function apiOrigin(env: Pick<Env, "CONSOLE_ORIGIN">): string | null {
  return usableOrigin(env.CONSOLE_ORIGIN?.trim() ?? "");
}
