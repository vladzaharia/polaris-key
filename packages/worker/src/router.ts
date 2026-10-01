// Pure route matching. Platform/manage/root-portal routes are matched FIRST so a product
// slug can never shadow them; everything else is `/<product>/...` and carries the product
// slug.
//
// ── ONE SHAPE FOR EVERY SERVICE ─────────────────────────────────────────────────────────────
//
// Wire v3 namespaces every product-scoped route under the service that owns it (plan §R1). All
// five have now moved: `/<p>/<slug>/…` does not resolve to a route KIND at all — it resolves to
// `{kind:"service"}` carrying the slug and the remaining segments, and the service's own
// descriptor routes them from there. That is what lets a product turn a service off and have its
// whole surface disappear rather than 403.
//
// `SERVICE_NAMESPACES` below is therefore the complete list, and there are no per-service route
// kinds left in this file. Identity was the last to cut over, and its old top-level spellings
// (`/<p>/session`, `/<p>/session/license`, `/<p>/auth/…`) are DELETED rather than aliased — see
// `services/identity/routes.ts` for why that is safe where the four Release/Update aliases below
// are not.
//
// Core routes stay core routes whatever happens to the services: discovery, JWKS, the trust
// manifest, `/devices[/:id]`, `/devices/report` and `/devices/register`.
//
// ── THE PERMANENT ALIASES (D-07) ────────────────────────────────────────────────────────────
//
// Four paths predate the namespacing and are baked into things nobody can recall: `SUFeedURL`
// values compiled into shipped app bundles, and `curl … | sh` lines in published documentation.
// They are kept FOREVER (spec §4.1), and they are implemented by REWRITING — the alias resolves
// to the same `{kind:"service"}` route, with the same segments, as its canonical spelling. There
// is therefore no second handler to keep in step and no way for the two to answer differently;
// the `alias` flag exists so a route table can be asserted on, not so a handler can branch.

import { SERVICE_SLUGS, type ServiceSlug } from "./core/services.js";

/**
 * The service slugs the core router dispatches through the registry today.
 *
 * Everything under `/<p>/<slug>/…` for a slug in this set is the service's to route, INCLUDING
 * paths the service does not implement — those become the registry's not-found, not a fall
 * through to some other matcher. That is why the set is checked before the channel-appcast
 * pattern below: a product may not have a release channel called `license`.
 */
const SERVICE_NAMESPACES: ReadonlySet<string> = new Set<ServiceSlug>(
  SERVICE_SLUGS,
);

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
  /** `/docs[/*]` — the platform-admin-gated documentation site (docs plan N7). A PLATFORM
   *  route reserved ahead of product slugs, like `/manage`: the gate + asset serving live in
   *  `docs.ts`, and the slug `docs` is on the reserved list so a product can never take it. */
  | { kind: "docs" }
  | { kind: "githubWebhook" }
  | { kind: "discovery"; product: string }
  | { kind: "jwks"; product: string }
  | { kind: "trustManifest"; product: string }
  | { kind: "devices"; product: string; deviceId?: string }
  /** `POST /<p>/devices/report` — core telemetry, relocated from `/<p>/config/report`. */
  | { kind: "report"; product: string }
  /** `POST /<p>/devices/register` — the keyless device-token mint (wire v3 §6). A CORE route,
   *  not a service one: the device principal is substrate, available under every policy. */
  | { kind: "register"; product: string }
  /** A product-scoped request for a service the core router has cut over. `rest` is the path
   *  after `/<product>/<slug>`, already split; `[]` means the bare namespace.
   *
   *  `alias` marks one of the four permanent pre-namespace spellings (§R1). It carries no
   *  behaviour: the route it produces is identical to the canonical one, which is the property
   *  the route tests pin. */
  | {
      kind: "service";
      slug: ServiceSlug;
      product: string;
      rest: string[];
      alias?: true;
    }
  | { kind: "notFound" };

/** One alias route: same slug, same segments, marked. */
function alias(slug: ServiceSlug, product: string, rest: string[]): Route {
  return { kind: "service", slug, product, rest, alias: true };
}

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
  // The gated docs site — reserved before product slugs, same as /manage.
  if (path === "/docs" || path.startsWith("/docs/")) return { kind: "docs" };

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
    // Ahead of the `/devices/<id>` pattern further down, so `report` and `register` can never
    // be read as device ids.
    case "/devices/report":
      return { kind: "report", product };
    case "/devices/register":
      return { kind: "register", product };
    // The permanent aliases (§R1). `/<p>/changelog` is NOT among them: unlike the four below it
    // was never compiled into a shipped binary or a published curl line, so wire v3 moves it to
    // `/<p>/release/changelog` outright.
    case "/appcast.xml":
      return alias("update", product, ["appcast.xml"]);
    case "/install.sh":
      return alias("release", product, ["install.sh"]);
    case "/version":
      return alias("update", product, ["version"]);
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

  // `/<p>/<channel>/appcast.xml` — the fourth permanent alias. Below the service-namespace
  // check above, so a product cannot have a release channel named after a service (`release`,
  // `update`, `distribution`, …) that shadows the service it belongs to. A manual channel that
  // shares a service's name keeps its canonical `/<p>/update/<channel>/appcast.xml`; only this
  // alias spelling is lost (`distribution` joined the namespaces in P2b-01).
  const appcast = rest.match(/^\/([a-z0-9-]+)\/appcast\.xml$/);
  if (appcast && appcast[1])
    return alias("update", product, [appcast[1], "appcast.xml"]);

  const devices = rest.match(/^\/devices\/([^/]+)$/);
  if (devices && devices[1])
    return {
      kind: "devices",
      product,
      deviceId: decodeURIComponent(devices[1]),
    };

  return { kind: "notFound" };
}
