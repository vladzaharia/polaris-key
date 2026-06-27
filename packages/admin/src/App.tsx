import * as React from "react";
import { AlertTriangle } from "lucide-react";
import { api, setCsrf, type Me } from "./api.js";
import { AdminProvider } from "./context.js";
import { ThemeProvider } from "./components/theme.js";
import { Toaster } from "./components/ui/index.js";
import { Shell } from "./components/Shell.js";
import { navigate, normalizeView, parseRoute, type Route } from "./route.js";
import { Spinner, EmptyState } from "./components/ui/index.js";
import { LogoMark } from "./components/brand/Logo.js";
import { Dashboard } from "./views/Dashboard.js";
import { Products } from "./views/Products.js";
import { ProductOverview } from "./views/ProductOverview.js";
import { Licenses } from "./views/Licenses.js";
import { LicenseDetail } from "./views/LicenseDetail.js";
import { Catalog } from "./views/Catalog.js";
import { Tiers } from "./views/Tiers.js";
import { Profiles } from "./views/Profiles.js";
import { Releases } from "./views/Releases.js";
import { Oidc } from "./views/Oidc.js";
import { Activity } from "./views/Activity.js";
import { Secrets } from "./views/Secrets.js";
import { Settings } from "./views/Settings.js";

/**
 * Top-level shell. Boots the admin identity + CSRF + the set of products the operator may
 * administer, then renders the responsive app frame. Routing is hash-based so deep links +
 * back/forward work without a router dependency.
 */
export function App(): React.ReactElement {
  return (
    <ThemeProvider>
      <Toaster>
        <Boot />
      </Toaster>
    </ThemeProvider>
  );
}

function Boot(): React.ReactElement {
  const [me, setMe] = React.useState<Me | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [route, setRoute] = React.useState<Route>(() =>
    parseRoute(window.location.hash),
  );

  React.useEffect(() => {
    const onHash = (): void => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  React.useEffect(() => {
    void (async () => {
      try {
        const m = await api.me();
        setCsrf(m.csrf);
        setMe(m);
      } catch {
        setError("Could not load the admin session.");
      }
    })();
  }, []);

  if (error) {
    return (
      <BootScreen>
        <EmptyState
          icon={<AlertTriangle aria-hidden />}
          title="Session unavailable"
          description={error}
        />
      </BootScreen>
    );
  }
  if (!me) {
    return (
      <BootScreen>
        <div className="flex items-center gap-3 text-muted-foreground">
          <Spinner className="size-5 text-primary" />
          Loading console…
        </div>
      </BootScreen>
    );
  }

  const activeSlug =
    route.kind === "product" ? route.slug : (me.products[0]?.slug ?? "");

  return (
    <AdminProvider
      value={{
        me,
        product: activeSlug,
        setProduct: (slug) =>
          navigate({ kind: "product", slug, view: "overview" }),
      }}
    >
      <Shell
        me={me}
        route={route}
        activeSlug={activeSlug}
        onNavigate={navigate}
        onSignOut={() =>
          void api
            .logout()
            .finally(() => (window.location.href = "/manage/login"))
        }
      >
        <div key={routeKey(route)}>{renderRoute(route, me, activeSlug)}</div>
      </Shell>
    </AdminProvider>
  );
}

function BootScreen({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <ThemeBackdrop>
      <div className="flex min-h-screen flex-col items-center justify-center gap-6 px-4">
        <LogoMark className="size-10" />
        {children}
      </div>
    </ThemeBackdrop>
  );
}

/** Apply background tokens even before the shell mounts. */
function ThemeBackdrop({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="min-h-screen bg-background text-foreground">{children}</div>
  );
}

function routeKey(route: Route): string {
  if (route.kind === "product") {
    const id = route.view === "license" ? route.id : "";
    return `${route.slug}:${route.view}:${id}`;
  }
  return route.kind;
}

function renderRoute(
  route: Route,
  me: Me,
  activeSlug: string,
): React.ReactElement {
  if (route.kind === "dashboard") return <Dashboard />;
  if (route.kind === "products") return <Products />;

  if (!me.products.some((prod) => prod.slug === activeSlug)) {
    return (
      <EmptyState
        icon={<AlertTriangle aria-hidden />}
        title="Not authorized"
        description={`You do not administer “${activeSlug}”.`}
      />
    );
  }

  const view = normalizeView(route.view);
  if (view === "license") {
    if (route.view !== "license") {
      return (
        <EmptyState
          icon={<AlertTriangle aria-hidden />}
          title="License not found"
          description="Choose a license from the Licenses view."
        />
      );
    }
    return <LicenseDetail slug={activeSlug} id={route.id} />;
  }

  switch (view) {
    case "overview":
      return <ProductOverview slug={activeSlug} />;
    case "licenses":
      return <Licenses slug={activeSlug} />;
    case "config":
      return <Catalog slug={activeSlug} />;
    case "tiers":
      return <Tiers slug={activeSlug} />;
    case "profiles":
      return <Profiles slug={activeSlug} />;
    case "releases":
      return <Releases slug={activeSlug} />;
    case "identity":
      return <Oidc slug={activeSlug} />;
    case "secrets":
      return <Secrets slug={activeSlug} />;
    case "activity":
      return <Activity slug={activeSlug} />;
    case "settings":
      return <Settings slug={activeSlug} />;
  }
}
