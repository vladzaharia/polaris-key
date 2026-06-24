import * as React from "react";
import { AlertTriangle } from "lucide-react";
import { api, setCsrf, type Me } from "./api.js";
import { AdminProvider } from "./context.js";
import { ThemeProvider } from "./components/theme.js";
import { Toaster } from "./components/ui/index.js";
import { Shell } from "./components/Shell.js";
import { navigate, parseRoute, TABS, type Route } from "./route.js";
import { Spinner, EmptyState } from "./components/ui/index.js";
import { LogoMark } from "./components/brand/Logo.js";
import { Dashboard } from "./views/Dashboard.js";
import { Products } from "./views/Products.js";
import { ComingSoon } from "./views/ComingSoon.js";

/**
 * Top-level shell. Boots the admin identity + CSRF + the set of products the operator may
 * administer, then renders the responsive app frame. Routing is hash-based so deep links +
 * back/forward work without a router dependency. Per-product views are placeholders other
 * agents fill — every route is reachable today so the app compiles and navigates.
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
  const [route, setRoute] = React.useState<Route>(() => parseRoute(window.location.hash));

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

  const activeSlug = route.kind === "product" ? route.slug : me.products[0]?.slug ?? "";

  return (
    <AdminProvider
      value={{
        me,
        product: activeSlug,
        setProduct: (slug) => navigate({ kind: "product", slug, view: "licenses" }),
      }}
    >
      <Shell
        me={me}
        route={route}
        activeSlug={activeSlug}
        onNavigate={navigate}
        onSignOut={() => void api.logout().finally(() => (window.location.href = "/admin/login"))}
      >
        <div key={routeKey(route)}>{renderRoute(route, me, activeSlug)}</div>
      </Shell>
    </AdminProvider>
  );
}

function BootScreen({ children }: { children: React.ReactNode }): React.ReactElement {
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
function ThemeBackdrop({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div className="min-h-screen bg-background text-foreground">{children}</div>;
}

function routeKey(route: Route): string {
  if (route.kind === "product") return `${route.slug}:${route.view}:${route.id ?? ""}`;
  return route.kind;
}

const TAB_LABEL = new Map(TABS.map((t) => [t.tab, t.label]));

function renderRoute(route: Route, me: Me, activeSlug: string): React.ReactElement {
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

  if (route.view === "license") {
    return (
      <ComingSoon
        title="License detail"
        description={`Detail for ${route.id ?? "a license"} — keys, machines, and overrides.`}
      />
    );
  }

  const label = TAB_LABEL.get(route.view) ?? "Console";
  // Every per-product tab renders a placeholder until its owning agent builds it.
  return <ComingSoon title={label} />;
}
