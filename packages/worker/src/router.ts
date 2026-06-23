// Pure route matching. Platform/admin routes are matched FIRST so a product slug can
// never shadow them; everything else is `/<product>/...` and carries the product slug.

export type Route =
  | { kind: "adminSpa" }
  | { kind: "adminApi" }
  | { kind: "adminLogin" }
  | { kind: "adminCallback" }
  | { kind: "products" }
  | { kind: "jwks"; product: string }
  | { kind: "schema"; product: string }
  | { kind: "enroll"; product: string }
  | { kind: "token"; product: string }
  | { kind: "deauthorize"; product: string }
  | { kind: "config"; product: string }
  | { kind: "configReport"; product: string }
  | { kind: "configSubscribe"; product: string }
  | { kind: "authStart"; product: string }
  | { kind: "authCallback"; product: string }
  | { kind: "authPoll"; product: string }
  | { kind: "mintToken"; product: string; mintId: string }
  | { kind: "mintAuth"; product: string; mintId: string }
  | { kind: "appcast"; product: string; channel?: string }
  | { kind: "notFound" };

export function matchRoute(pathname: string): Route {
  const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;

  // Platform + admin (matched before product slugs).
  if (path === "/admin/api/products" || path.startsWith("/admin/api/products/")) return { kind: "products" };
  if (path === "/admin/login") return { kind: "adminLogin" };
  if (path === "/admin/callback") return { kind: "adminCallback" };
  if (path === "/admin/api" || path.startsWith("/admin/api/")) return { kind: "adminApi" };
  if (path === "/admin" || path.startsWith("/admin/")) return { kind: "adminSpa" };

  // Product-scoped: /<product>/<rest>
  const m = path.match(/^\/([a-z0-9-]+)\/(.+)$/);
  if (!m || !m[1] || !m[2]) return { kind: "notFound" };
  const product = m[1];
  const rest = "/" + m[2];

  switch (rest) {
    case "/.well-known/jwks.json":
      return { kind: "jwks", product };
    case "/schema":
      return { kind: "schema", product };
    case "/enroll":
      return { kind: "enroll", product };
    case "/token":
      return { kind: "token", product };
    case "/deauthorize":
      return { kind: "deauthorize", product };
    case "/config":
      return { kind: "config", product };
    case "/config/report":
      return { kind: "configReport", product };
    case "/config/subscribe":
      return { kind: "configSubscribe", product };
    case "/auth/start":
      return { kind: "authStart", product };
    case "/auth/callback":
      return { kind: "authCallback", product };
    case "/auth/poll":
      return { kind: "authPoll", product };
    case "/appcast.xml":
      return { kind: "appcast", product };
  }

  const mint = rest.match(/^\/mint\/([a-z0-9-]+)\/(token|auth)$/);
  if (mint && mint[1] && mint[2]) {
    return mint[2] === "token"
      ? { kind: "mintToken", product, mintId: mint[1] }
      : { kind: "mintAuth", product, mintId: mint[1] };
  }

  const appcast = rest.match(/^\/([a-z0-9-]+)\/appcast\.xml$/);
  if (appcast && appcast[1]) return { kind: "appcast", product, channel: appcast[1] };

  return { kind: "notFound" };
}
