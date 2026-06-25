// Pure route matching. Platform/admin routes are matched FIRST so a product slug can
// never shadow them; everything else is `/<product>/...` and carries the product slug.

export type Route =
  | { kind: "adminSpa" }
  | { kind: "adminApi" }
  | { kind: "adminLogin" }
  | { kind: "adminCallback" }
  | { kind: "products" }
  | { kind: "githubWebhook" }
  | { kind: "discovery"; product: string }
  | { kind: "jwks"; product: string }
  | { kind: "schema"; product: string }
  | { kind: "enroll"; product: string }
  | { kind: "token"; product: string }
  | { kind: "deauthorize"; product: string }
  | { kind: "config"; product: string }
  | { kind: "configReport"; product: string }
  | { kind: "configSubscribe"; product: string }
  | { kind: "browserSession"; product: string }
  | { kind: "browserSessionLicense"; product: string }
  | { kind: "authStart"; product: string }
  | { kind: "authLogin"; product: string }
  | { kind: "authLogout"; product: string }
  | { kind: "authDeviceStart"; product: string }
  | { kind: "authDevicePoll"; product: string }
  | { kind: "authCallback"; product: string }
  | { kind: "authPoll"; product: string }
  | { kind: "mintToken"; product: string; mintId: string }
  | { kind: "mintAuth"; product: string; mintId: string }
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

  // Platform + admin (matched before product slugs).
  if (path === "/admin/api/products" || path.startsWith("/admin/api/products/"))
    return { kind: "products" };
  if (path === "/webhooks/github") return { kind: "githubWebhook" };
  if (path === "/admin/login") return { kind: "adminLogin" };
  if (path === "/admin/callback") return { kind: "adminCallback" };
  if (path === "/admin/api" || path.startsWith("/admin/api/"))
    return { kind: "adminApi" };
  if (path === "/admin" || path.startsWith("/admin/"))
    return { kind: "adminSpa" };

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

  const mint = rest.match(/^\/mint\/([a-z0-9-]+)\/(token|auth)$/);
  if (mint && mint[1] && mint[2]) {
    return mint[2] === "token"
      ? { kind: "mintToken", product, mintId: mint[1] }
      : { kind: "mintAuth", product, mintId: mint[1] };
  }

  const appcast = rest.match(/^\/([a-z0-9-]+)\/appcast\.xml$/);
  if (appcast && appcast[1])
    return { kind: "appcast", product, channel: appcast[1] };

  return { kind: "notFound" };
}
