import * as React from "react";
import { AlertTriangle, Blocks } from "lucide-react";
import { api, setCsrf, type Me } from "./api.js";
import { AdminProvider, useProductServices } from "./context.js";
import { ThemeProvider } from "./components/theme.js";
import { Toaster } from "./components/ui/index.js";
import { Shell } from "./components/Shell.js";
import {
  isLeaf,
  isTabEnabled,
  LEAF_PARENT,
  navigate,
  normalizeView,
  parseRoute,
  sectionOf,
  type Route,
  type ServiceState,
  type Tab,
} from "./route.js";
import { Button, Spinner, EmptyState } from "./components/ui/index.js";
import { LogoMark } from "./components/brand/Logo.js";
import { Dashboard } from "./views/Dashboard.js";
import { Products } from "./views/Products.js";
import { ProductOverview } from "./views/ProductOverview.js";
import { Services } from "./views/Services.js";
import { Licenses } from "./views/Licenses.js";
import { LicenseDetail } from "./views/LicenseDetail.js";
import { FingerprintPolicy } from "./views/FingerprintPolicy.js";
import { Catalog } from "./views/Catalog.js";
import { Tiers } from "./views/Tiers.js";
import { Profiles } from "./views/Profiles.js";
import { ProfileDetail } from "./views/profiles/ProfileDetail.js";
import { Releases } from "./views/Releases.js";
import { Deliverables } from "./views/releases/Deliverables.js";
import { Compatibility } from "./views/releases/Compatibility.js";
import { DeliverableDetail } from "./views/releases/DeliverableDetail.js";
import { UpdateSettings } from "./views/UpdateSettings.js";
import { Distribution } from "./views/Distribution.js";
import { DistributionMatrixView } from "./views/distribution/Matrix.js";
import { UpdateHealthView } from "./views/distribution/UpdateHealth.js";
import { Identity } from "./views/Identity.js";
import { Activity } from "./views/Activity.js";
import { Devices } from "./views/Devices.js";
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

  const activeSlug =
    route.kind === "product" ? route.slug : (me?.products[0]?.slug ?? "");
  // Read ABOVE the boot early-returns — a hook after them would change the hook count the
  // render `me` lands on. Both the sidebar and the router get the same answer for a render,
  // which is the point: a nav that hid a section the router still rendered would be worse than
  // either behaviour on its own. Off a product route the slug is the switcher's default, which
  // is exactly the product whose sections the sidebar draws, so this is never a wasted read.
  const services = useProductServices(activeSlug);

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
          <Spinner className="size-5 text-accent-fg" />
          Loading console…
        </div>
      </BootScreen>
    );
  }

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
        services={services}
        onNavigate={navigate}
        onSignOut={() =>
          void api
            .logout()
            .finally(() => (window.location.href = "/manage/login"))
        }
      >
        <div key={routeKey(route)}>
          {renderRoute(route, me, activeSlug, services)}
        </div>
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
        {/* Before the shell knows the route: the default mark, with no bit (BRAND.md §6). */}
        <LogoMark size={48} />
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
    const id = "id" in route ? route.id : "";
    return `${route.slug}:${route.view}:${id}`;
  }
  return route.kind;
}

/**
 * A deep link into a service this product does not run (D-15).
 *
 * The nav has already dropped the section, so the only way here is a bookmark, a shared URL, or
 * a service someone turned off in another tab. Rendering the view anyway would fire requests the
 * worker answers with 404/409 and leave the operator staring at a broken table; a bare 404 would
 * not say WHY. So: name the service, and put the one action that fixes it — Platform → Services
 * — a click away, since the product itself is not in question, only its enablement.
 */
function ServiceDisabled({
  slug,
  tab,
}: {
  slug: string;
  tab: Tab;
}): React.ReactElement {
  const section = sectionOf(tab);
  return (
    <EmptyState
      icon={<Blocks aria-hidden />}
      title={`The ${section.label} service isn’t enabled`}
      description={`This product doesn’t run the ${section.label} service, so there is nothing here to manage. Turn it on under Platform → Services and this view comes back.`}
      action={
        <Button
          onClick={() => navigate({ kind: "product", slug, view: "services" })}
        >
          Enable services
        </Button>
      }
    />
  );
}

function renderRoute(
  route: Route,
  me: Me,
  activeSlug: string,
  services: ServiceState,
): React.ReactElement {
  if (route.kind === "dashboard") return <Dashboard />;
  if (route.kind === "products") return <Products />;

  // `handleMe` returns every product or none — admin authority is platform-wide and there is
  // no per-product grant to be missing. So the only way to land here is a hash pointing at a
  // slug that does not exist. Saying "not authorized" implied an ACL to go and fix, and sent
  // the operator looking for a permission nobody can issue.
  if (!me.products.some((prod) => prod.slug === activeSlug)) {
    return (
      <EmptyState
        icon={<AlertTriangle aria-hidden />}
        title="Unknown product"
        description={`No product with the slug “${activeSlug}” exists.`}
      />
    );
  }

  const view = normalizeView(route.view);
  // A detail leaf is not a nav tab, but it is unambiguously its service's surface — gate it on
  // the tab it hangs off, or a `#/p/x/licenses/<id>` bookmark would sail past the check that
  // stops `#/p/x/licenses`.
  const tab: Tab = isLeaf(view) ? LEAF_PARENT[view] : view;
  if (!isTabEnabled(tab, services)) {
    return <ServiceDisabled slug={activeSlug} tab={tab} />;
  }

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

  if (view === "profile") {
    if (route.view !== "profile") {
      return (
        <EmptyState
          icon={<AlertTriangle aria-hidden />}
          title="Profile not found"
          description="Choose a profile from the Profiles view."
        />
      );
    }
    return <ProfileDetail slug={activeSlug} id={route.id} />;
  }

  if (view === "deliverable") {
    if (route.view !== "deliverable") {
      return (
        <EmptyState
          icon={<AlertTriangle aria-hidden />}
          title="Deliverable not found"
          description="Choose a pack from the Deliverables view."
        />
      );
    }
    return <DeliverableDetail slug={activeSlug} id={route.id} />;
  }

  switch (view) {
    case "overview":
      return <ProductOverview slug={activeSlug} />;
    case "services":
      return <Services slug={activeSlug} />;
    case "devices":
      return <Devices slug={activeSlug} />;
    case "secrets":
      return <Secrets slug={activeSlug} />;
    case "activity":
      return <Activity slug={activeSlug} />;
    case "settings":
      return <Settings slug={activeSlug} />;
    case "licenses":
      return <Licenses slug={activeSlug} />;
    case "tiers":
      return <Tiers slug={activeSlug} />;
    case "fingerprints":
      return <FingerprintPolicy slug={activeSlug} />;
    case "config":
      return <Catalog slug={activeSlug} />;
    case "profiles":
      return <Profiles slug={activeSlug} />;
    case "releases":
      return <Releases slug={activeSlug} />;
    case "deliverables":
      return <Deliverables slug={activeSlug} />;
    case "compatibility":
      return <Compatibility slug={activeSlug} />;
    case "distribution":
      return <Distribution slug={activeSlug} />;
    case "distribution-matrix":
      return <DistributionMatrixView slug={activeSlug} />;
    case "distribution-health":
      return <UpdateHealthView slug={activeSlug} />;
    case "updates":
      return <UpdateSettings slug={activeSlug} />;
    case "identity":
      return <Identity slug={activeSlug} />;
  }
}
