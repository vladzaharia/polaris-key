// Pure route matching. Platform/manage/root-portal routes are matched FIRST so a product
// slug can never shadow them; everything else is `/<product>/...` and carries the product
// slug.
//
// ── THE HYBRID STATE ────────────────────────────────────────────────────────────────────────
//
// Wire v3 namespaces every product-scoped route under the service that owns it (plan §R1).
// License and Config have moved: `/<p>/license/…` and `/<p>/config/…` no longer resolve to a
// route KIND at all — they resolve to `{kind:"service"}` carrying the slug and the remaining
// segments, and the service's own descriptor routes them from there. That is what lets a
// product turn a service off and have its whole surface disappear rather than 403.
//
// Release, Update and Identity have not moved yet (P2/P3), so their paths keep their existing
// kinds and their existing dispatch. This file is deliberately readable as "which services
// have been cut over": the `SERVICE_NAMESPACES` set below is the complete answer, and adding a
// slug to it is what moves the next one.
//
// Core routes stay core routes whatever happens to the services: discovery, JWKS, the trust
// manifest, `/devices[/:id]` and `/devices/report`.

import type { ServiceSlug } from "./core/services.js";

/**
 * The service slugs the core router dispatches through the registry today.
 *
 * Everything under `/<p>/<slug>/…` for a slug in this set is the service's to route, INCLUDING
 * paths the service does not implement — those become the registry's not-found, not a fall
 * through to some other matcher. That is why the set is checked before the channel-appcast
 * pattern below: a product may not have a release channel called `license`.
 */
const SERVICE_NAMESPACES: ReadonlySet<string> = new Set<ServiceSlug>([
  "license",
  "config",
]);

export type Route =
  | { kind: "adminSpa" }
  | { kind: "adminApi" }
  | { kind: "adminLogin" }
  | { kind: "adminCallback" }
  | { kind: "portalSpa" }
  | { kind: "portalApi" }
  | { kind: "portalLogin" }
  | { kind: "portalCallback" }
  | { kind: "portalLogout" }
  | { kind: "portalMagicVerify" }
  | { kind: "portalDownload"; token: string }
  | { kind: "products" }
  | { kind: "githubWebhook" }
  | { kind: "discovery"; product: string }
  | { kind: "jwks"; product: string }
  | { kind: "trustManifest"; product: string }
  | { kind: "devices"; product: string; deviceId?: string }
  /** `POST /<p>/devices/report` — core telemetry, relocated from `/<p>/config/report`. */
  | { kind: "report"; product: string }
  /** A product-scoped request for a service the core router has cut over. `rest` is the path
   *  after `/<product>/<slug>`, already split; `[]` means the bare namespace. */
  | { kind: "service"; slug: ServiceSlug; product: string; rest: string[] }
  | { kind: "browserSession"; product: string }
  | { kind: "browserSessionLicense"; product: string }
  | { kind: "authStart"; product: string }
  | { kind: "authLogin"; product: string }
  | { kind: "authLogout"; product: string }
  | { kind: "authDeviceStart"; product: string }
  | { kind: "authDeviceVerify"; product: string }
  | { kind: "authDevicePoll"; product: string }
  | { kind: "authCallback"; product: string }
  | { kind: "authPoll"; product: string }
  | { kind: "appcast"; product: string; channel?: string }
  | { kind: "install"; product: string }
  | { kind: "version"; product: string }
  | { kind: "changelog"; product: string }
  | { kind: "cli"; product: string; version: string; arch: string }
  | { kind: "dmg"; product: string; version: string; arch: string }
  | { kind: "notFound" };

const ARCH = /^(?:[^/]+)-(arm64|aarch64|x86_64|amd64)$/;

export function matchRoute(pathname: string): Route {
  const path =
    pathname.length > 1 && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;

  // Platform + manage routes (matched before product slugs).
  if (
    path === "/manage/api/products" ||
    path.startsWith("/manage/api/products/")
  )
    return { kind: "products" };
  if (path === "/webhooks/github") return { kind: "githubWebhook" };
  if (path === "/manage/login") return { kind: "adminLogin" };
  if (path === "/manage/callback") return { kind: "adminCallback" };
  if (path === "/manage/api" || path.startsWith("/manage/api/"))
    return { kind: "adminApi" };
  if (path === "/manage" || path.startsWith("/manage/"))
    return { kind: "adminSpa" };

  // Root customer portal. These are reserved before product slugs.
  if (path === "/" || path === "/index.html" || path.startsWith("/assets/"))
    return { kind: "portalSpa" };
  if (path === "/login") return { kind: "portalLogin" };
  if (path === "/callback") return { kind: "portalCallback" };
  if (path === "/logout") return { kind: "portalLogout" };
  if (path === "/magic/verify") return { kind: "portalMagicVerify" };
  if (path === "/api" || path.startsWith("/api/")) return { kind: "portalApi" };
  const portalDownload = path.match(/^\/download\/([^/]+)$/);
  if (portalDownload?.[1])
    return {
      kind: "portalDownload",
      token: decodeURIComponent(portalDownload[1]),
    };

  // Product-scoped: /<product>/<rest>
  const m = path.match(/^\/([a-z0-9-]+)\/(.+)$/);
  if (!m || !m[1] || !m[2]) return { kind: "notFound" };
  const product = m[1];
  const rest = "/" + m[2];

  switch (rest) {
    case "/.well-known/polaris.json":
      return { kind: "discovery", product };
    case "/.well-known/jwks.json":
      return { kind: "jwks", product };
    case "/.well-known/polaris-trust.jws":
      return { kind: "trustManifest", product };
    case "/devices":
      return { kind: "devices", product };
    // Ahead of the `/devices/<id>` pattern further down, so `report` can never be read as a
    // device id.
    case "/devices/report":
      return { kind: "report", product };
    case "/session":
      return { kind: "browserSession", product };
    case "/session/license":
      return { kind: "browserSessionLicense", product };
    case "/auth/start":
      return { kind: "authStart", product };
    case "/auth/login":
      return { kind: "authLogin", product };
    case "/auth/logout":
      return { kind: "authLogout", product };
    case "/auth/device/start":
      return { kind: "authDeviceStart", product };
    case "/auth/device/verify":
      return { kind: "authDeviceVerify", product };
    case "/auth/device/poll":
      return { kind: "authDevicePoll", product };
    case "/auth/callback":
      return { kind: "authCallback", product };
    case "/auth/poll":
      return { kind: "authPoll", product };
    case "/appcast.xml":
      return { kind: "appcast", product };
    case "/install.sh":
      return { kind: "install", product };
    case "/version":
      return { kind: "version", product };
    case "/changelog":
      return { kind: "changelog", product };
  }

  // /<product>/<service>/<rest…> for the services that have been cut over. Placed before the
  // channel-appcast and download patterns so a service namespace can never be shadowed by a
  // release channel or a binary name.
  const svc = rest.match(/^\/([a-z0-9-]+)(?:\/(.+))?$/);
  if (svc?.[1] && SERVICE_NAMESPACES.has(svc[1])) {
    return {
      kind: "service",
      slug: svc[1] as ServiceSlug,
      product,
      rest: svc[2] ? svc[2].split("/") : [],
    };
  }

  // /cli/<version>/<binary>-<arch>
  const cli = rest.match(/^\/cli\/([^/]+)\/([^/]+)$/);
  if (cli && cli[1] && cli[2]) {
    const a = cli[2].match(ARCH);
    if (a && a[1]) return { kind: "cli", product, version: cli[1], arch: a[1] };
  }
  // /dmg/<version>/<binary>-<arch>.dmg
  const dmg = rest.match(/^\/dmg\/([^/]+)\/([^/]+)\.dmg$/);
  if (dmg && dmg[1] && dmg[2]) {
    const a = dmg[2].match(ARCH);
    if (a && a[1]) return { kind: "dmg", product, version: dmg[1], arch: a[1] };
  }

  const appcast = rest.match(/^\/([a-z0-9-]+)\/appcast\.xml$/);
  if (appcast && appcast[1])
    return { kind: "appcast", product, channel: appcast[1] };

  const devices = rest.match(/^\/devices\/([^/]+)$/);
  if (devices && devices[1])
    return {
      kind: "devices",
      product,
      deviceId: decodeURIComponent(devices[1]),
    };

  return { kind: "notFound" };
}
