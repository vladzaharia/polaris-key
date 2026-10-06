import * as React from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { X } from "lucide-react";
import { type Me } from "../../api.js";
import { AdminProvider } from "../../context.js";
import { PageSkeleton, type SkeletonTemplate } from "../../ui/Skeleton.js";
import { TooltipProvider } from "../../ui/Tooltip.js";
import { usePlatformVersion, useProduct, useProducts } from "../data/hooks.js";
import {
  accentOf,
  docsFor,
  groupOf,
  isPageEnabled,
  isPlatformPage,
  isProductPage,
  pageOf,
  PRODUCT_PAGES,
  sectionOf,
  type GlobalPageId,
  type NavFeatures,
  type ProductPageId,
  type ServiceState,
} from "../nav.js";
import { navigate, useLocation } from "../router.js";
import {
  pageOfRoute,
  productPage,
  r,
  slugOfRoute,
  viewKey,
  type Route,
} from "../routes.js";
import { PREF_KEYS, readPref, writePref } from "../storage.js";
import { useGlobalShortcuts } from "../shortcuts.js";
import { prefetchSection, sectionPages } from "../pages/index.js";
import { Home } from "../pages/global/Home.js";
import { ProductNew } from "../pages/global/ProductNew.js";
import { Products } from "../pages/global/Products.js";
import { LiveRegion, type ProductLike } from "./bits.js";
import {
  CommandPalette,
  navigationSource,
  productSource,
} from "./CommandPalette.js";
import { LegacyPage } from "./LegacyPage.js";
import { PageErrorBoundary } from "./PageErrorBoundary.js";
import { ShortcutSheet } from "./ShortcutSheet.js";
import { Sidebar, useNavCollapse } from "./Sidebar.js";
import {
  NotFoundPage,
  ServiceOffPage,
  UnknownProductPage,
} from "./StatePages.js";
import { TopBar } from "./TopBar.js";
import { mutate } from "../../console/data/mutations.js";

/** The Platform section's pages: one lazy chunk (notes/S-13 §9.1). */
const PlatformPages = React.lazy(() => import("../pages/platform.js"));

/** Where the sidebar is part of the layout and the mobile drawer has no place. */
export const DESKTOP_QUERY = "(min-width: 1024px)";

/** The top bar's menu button, which the mobile drawer returns focus to. */
export const NAV_BUTTON_ID = "console-nav-button";

/** The title of the page a route shows, without the product (ADMIN.md §2.6 `document.title`). */
export function pageTitle(route: Route): string {
  if (route.kind === "not-found") return "Page not found";
  const page = pageOf(route.page);
  if (route.child && page.record?.child) {
    return `${page.record.child.noun} ${route.child.ids[route.child.ids.length - 1]}`;
  }
  if (route.id !== undefined && page.record) {
    return `${page.record.noun} ${route.id}`;
  }
  return page.label;
}

/** `"{page title} · {product} · Polaris Key"`, or `"{page title} · Polaris Key"` off a product. */
export function documentTitle(
  route: Route,
  productName: string | null,
): string {
  return [pageTitle(route), productName, "Polaris Key"]
    .filter(Boolean)
    .join(" · ");
}

function readRail(): boolean | null {
  return readPref<boolean | null>(
    PREF_KEYS.sidebarRail,
    (v) => (typeof v === "boolean" ? v : undefined),
    null,
  );
}

/** Narrower than 1280 px the desktop sidebar starts as a rail, unless the viewer chose otherwise. */
function defaultRail(): boolean {
  return (
    typeof window !== "undefined" &&
    window.innerWidth >= 1024 &&
    window.innerWidth < 1280
  );
}

/**
 * After a navigation: scroll back to the top (owner, 2026-10-03), move focus to the page's `<h1>`
 * and announce "{title}, page loaded" (ADMIN.md §5.6). `key` changes with the page or record,
 * not with its query string, so filtering a list never jumps. The first render is left alone,
 * so the skip link stays the first stop.
 * A page whose heading renders late (after its data) is waited for, briefly.
 */
function useRouteFocus(key: string, title: string): string {
  const [message, setMessage] = React.useState("");
  const first = React.useRef(true);
  React.useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setMessage(`${title}, page loaded`);
    const main = document.getElementById("content");
    // The page scrolls inside <main>; reset it and the window, in case a layout scrolls the body.
    if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
    if (!main) return;
    main.scrollTop = 0;
    const find = (): HTMLElement | null =>
      main.querySelector<HTMLElement>("h1, [aria-level='1']");
    const focus = (el: HTMLElement): void => {
      if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
      // The heading is at the top already; don't let focusing it move the reset scroll.
      el.focus({ preventScroll: true });
    };
    const now = find();
    if (now) {
      focus(now);
      return;
    }
    const observer = new MutationObserver(() => {
      const el = find();
      if (el) {
        observer.disconnect();
        focus(el);
      }
    });
    observer.observe(main, {
      childList: true,
      subtree: true,
      attributes: true,
    });
    const timer = window.setTimeout(() => observer.disconnect(), 4000);
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [key, title]);
  return message;
}

/**
 * The console frame (ADMIN.md §2, components.md §1.1).
 *
 * Layout: a 64 px top bar over a grid of sidebar and main column that scroll independently, at
 * full viewport height (fixes SH-3). The sidebar is 15 rem, or a 3.5 rem icon rail (persisted per
 * viewer; the default under 1280 px). Under 1024 px it is hidden and opens as a modal drawer from
 * the top bar: focus trapped, Escape closes, the page behind is inert, focus returns to the menu
 * button (fixes SH-2).
 */
export function AppShell({ me }: { me: Me }): React.ReactElement {
  const { route } = useLocation();
  const page = pageOfRoute(route);
  const routeSlug = slugOfRoute(route);
  const knownProduct =
    routeSlug !== null && me.products.some((p) => p.slug === routeSlug);
  const slug = knownProduct ? routeSlug : null;

  const productQuery = useProduct(slug);
  const products = useProducts();
  const services: ServiceState = productQuery.data?.services ?? null;
  const features: NavFeatures = productQuery.data
    ? { packageFeeds: productQuery.data.packageFeeds === true }
    : null;
  const productRef = slug
    ? (me.products.find((p) => p.slug === slug) ?? null)
    : null;
  const product: ProductLike | null = productQuery.data ?? productRef;
  // The system product (F-03) is the platform's, reached from Platform, never switched to.
  const productList: ProductLike[] = (products.data ?? me.products).filter(
    (p) => !(p as { system?: boolean }).system,
  );
  const productName = product?.name ?? null;

  const section = page ? sectionOf(page) : null;
  // The sidebar group holding the page: its product section, or the Platform section.
  const group = page ? groupOf(page) : null;
  const accent = page ? accentOf(page) : "core";
  const productPageId: ProductPageId | null =
    route.kind === "product" ? route.page : null;

  // The section rides <html> too, so what Radix portals out of this tree (dialogs, menus) takes
  // the section's accent, and the header mark's bit follows the route (BRAND.md §6).
  React.useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-service", accent);
    return () => root.removeAttribute("data-service");
  }, [accent]);

  const title = documentTitle(
    route,
    routeSlug && knownProduct ? productName : null,
  );
  React.useEffect(() => {
    document.title = title;
  }, [title]);

  const [rail, setRail] = React.useState<boolean>(
    () => readRail() ?? defaultRail(),
  );
  const toggleRail = React.useCallback(() => {
    setRail((v) => {
      writePref(PREF_KEYS.sidebarRail, !v);
      return !v;
    });
  }, []);
  const [navOpen, setNavOpen] = React.useState(false);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const [switcherOpen, setSwitcherOpen] = React.useState(false);
  const { expanded, toggle } = useNavCollapse(group);
  const version = usePlatformVersion();

  const key = viewKey(route);
  React.useEffect(() => {
    setNavOpen(false);
  }, [key]);
  // The drawer exists only under 1024 px. If the window grows past that with it open, its modal
  // layer (inert page, pointer lock, scroll lock) would stay mounted over the desktop layout with
  // nothing visible to close it, so close it.
  React.useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const desktop = window.matchMedia(DESKTOP_QUERY);
    const onChange = (): void => {
      if (desktop.matches) setNavOpen(false);
    };
    desktop.addEventListener("change", onChange);
    return () => desktop.removeEventListener("change", onChange);
  }, []);
  const announcement = useRouteFocus(key, pageTitle(route));

  useGlobalShortcuts({
    openPalette: () => setPaletteOpen(true),
    togglePalette: () => setPaletteOpen((o) => !o),
    openSheet: () => setSheetOpen(true),
    toggleSidebar: toggleRail,
    go: (k) => {
      if (k === "h") return navigate(r.home());
      if (k === "p") {
        if (slug && productPageId) setSwitcherOpen(true);
        else navigate(r.products());
        return true;
      }
      if (!slug) return false;
      const target = PRODUCT_PAGES.find((p) => p.shortcut === k && p.ready);
      if (!target || !isPageEnabled(target.page as ProductPageId, services))
        return false;
      return navigate(productPage(slug, target.page as ProductPageId));
    },
  });

  const signOut = (): void => {
    void mutate("logout").finally(() => {
      window.location.href = "/manage/login";
    });
  };

  const paletteItems = [
    ...navigationSource(slug, productName, services, features),
    ...productSource(productList),
  ];

  const sidebarProps = {
    slug,
    services,
    features,
    activePage: page,
    activeSection: group,
    expanded,
    onToggleSection: toggle,
    onPrefetch: prefetchSection,
  };

  return (
    <TooltipProvider delayDuration={300}>
      <AdminProvider
        value={{
          me,
          product: slug ?? "",
          setProduct: (s) => navigate(r.overview(s)),
        }}
      >
        <div
          data-service={accent}
          style={
            { "--sidebar-w": rail ? "3.5rem" : "15rem" } as React.CSSProperties
          }
          className="relative grid h-dvh grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-background text-foreground lg:grid-cols-[var(--sidebar-w)_minmax(0,1fr)]"
        >
          <a
            href="#content"
            onClick={(e) => {
              e.preventDefault();
              document.getElementById("content")?.focus();
            }}
            className="sr-only z-50 rounded-md bg-surface-overlay px-3 py-2 text-sm font-bold focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:ring-2 focus:ring-focus"
          >
            Skip to content
          </a>
          <TopBar
            className="lg:col-span-2"
            me={me}
            section={accent}
            product={slug ? product : null}
            products={productList}
            page={productPageId}
            switcherOpen={switcherOpen}
            onSwitcherOpenChange={setSwitcherOpen}
            docsHref={page ? docsFor(page) : "/docs/admin/"}
            onOpenPalette={() => setPaletteOpen(true)}
            onOpenNav={() => setNavOpen(true)}
            onShortcuts={() => setSheetOpen(true)}
            onSignOut={signOut}
            version={version.data ?? null}
          />
          <aside className="hidden min-h-0 flex-col border-r border-border bg-surface-page lg:flex">
            <Sidebar
              {...sidebarProps}
              rail={rail}
              onToggleRail={toggleRail}
              idPrefix="sidebar"
            />
          </aside>
          <main
            id="content"
            tabIndex={-1}
            className="relative min-h-0 overflow-y-auto outline-hidden pk-scroll"
          >
            <div
              data-service={accent}
              className="mx-auto w-full max-w-[80rem] px-4 py-6 sm:px-6 lg:px-8"
            >
              <PageContent
                key={key}
                route={route}
                me={me}
                knownProduct={knownProduct}
                services={services}
                productName={productName ?? routeSlug ?? ""}
                onOpenPalette={() => setPaletteOpen(true)}
              />
            </div>
          </main>
        </div>

        <DialogPrimitive.Root open={navOpen} onOpenChange={setNavOpen}>
          <DialogPrimitive.Portal>
            <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/50 animate-pk-overlay-in lg:hidden" />
            <DialogPrimitive.Content
              aria-describedby={undefined}
              onCloseAutoFocus={(e) => {
                // The drawer is opened from the top bar, not a Radix trigger: hand focus back.
                e.preventDefault();
                document.getElementById(NAV_BUTTON_ID)?.focus();
              }}
              className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r border-border bg-surface-page pt-[env(safe-area-inset-top,0px)] shadow-pk-lg animate-pk-in pk-nav-drawer lg:hidden"
            >
              <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
                <DialogPrimitive.Title className="text-sm font-bold text-fg-strong">
                  Navigation
                </DialogPrimitive.Title>
                <DialogPrimitive.Close
                  aria-label="Close navigation"
                  className="rounded-md p-1.5 text-fg-muted hover:bg-hover hover:text-fg-strong focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus"
                >
                  <X aria-hidden className="size-4" />
                </DialogPrimitive.Close>
              </div>
              <Sidebar
                {...sidebarProps}
                idPrefix="drawer"
                onNavigate={() => setNavOpen(false)}
              />
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        </DialogPrimitive.Root>

        <CommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          items={paletteItems}
        />
        <ShortcutSheet open={sheetOpen} onOpenChange={setSheetOpen} />
        <LiveRegion message={announcement} id="route-announcer" />
      </AdminProvider>
    </TooltipProvider>
  );
}

/**
 * The skeleton template a route's page draws (components.md §5.3): a record, a dashboard, a form
 * or a list. The lazy chunk's fallback guesses it from the route so the page does not jump when
 * the chunk lands.
 */
export function routeSkeleton(route: Route): SkeletonTemplate {
  if (route.kind === "not-found") return "table";
  if (route.id !== undefined || route.child) return "record";
  if (
    route.page === "overview" ||
    route.page === "platform" ||
    route.page === "platform-deployment" ||
    route.page === "platform-operations"
  )
    return "dashboard";
  if (route.page === "platform-settings") return "form";
  return "table";
}

/**
 * A lazy section's fallback (S-23 §6.1 skeleton): the page's shape, shown only after the 150 ms
 * grace (`pk-skeleton-group`, a delay that survives reduced motion), so a cached chunk never
 * flashes it. No spinner and no visible "Loading…": the skeleton announces itself politely.
 */
export function PageLoading({ route }: { route: Route }): React.ReactElement {
  return (
    <div aria-busy="true" data-page-loading="" className="pk-skeleton-group">
      <PageSkeleton template={routeSkeleton(route)} label="the page" />
    </div>
  );
}

/** A global page: Home, Products, the new-product wizard, or a Platform section page. */
function globalPageFor(
  route: Extract<Route, { kind: "global" }>,
): React.ReactElement {
  const page = route.page;
  if (isPlatformPage(page)) {
    return (
      <React.Suspense fallback={<PageLoading route={route} />}>
        <PlatformPages page={page} route={route} />
      </React.Suspense>
    );
  }
  if (page === "products") return <Products />;
  if (page === "product-new") return <ProductNew />;
  return <Home />;
}

/** What the main column shows for a route: a state page, a global page or a section page. */
function PageContent({
  route,
  me,
  knownProduct,
  services,
  productName,
  onOpenPalette,
}: {
  route: Route;
  me: Me;
  knownProduct: boolean;
  services: ServiceState;
  productName: string;
  onOpenPalette: () => void;
}): React.ReactElement {
  if (route.kind === "not-found") {
    if (route.slug && !me.products.some((p) => p.slug === route.slug)) {
      return <UnknownProductPage slug={route.slug} products={me.products} />;
    }
    return (
      <NotFoundPage
        path={route.path}
        slug={route.slug}
        productName={route.slug ? productName : undefined}
        onOpenPalette={onOpenPalette}
      />
    );
  }
  if (route.kind === "global") {
    return <PageErrorBoundary>{globalPageFor(route)}</PageErrorBoundary>;
  }
  // `/me` lists every product the session administers (authority is platform-wide), so a slug
  // outside it does not exist; it is not an authorization failure.
  if (!knownProduct) {
    return <UnknownProductPage slug={route.slug} products={me.products} />;
  }
  if (!isProductPage(route.page)) {
    return (
      <NotFoundPage
        path={route.page}
        slug={route.slug}
        onOpenPalette={onOpenPalette}
      />
    );
  }
  const section = sectionOf(route.page)!;
  if (!isPageEnabled(route.page, services)) {
    return (
      <ServiceOffPage
        section={section}
        slug={route.slug}
        productName={productName}
      />
    );
  }
  const Pages = sectionPages(section.key);
  return (
    <React.Suspense fallback={<PageLoading route={route} />}>
      <PageErrorBoundary>
        <LegacyPage>
          <Pages route={route} />
        </LegacyPage>
      </PageErrorBoundary>
    </React.Suspense>
  );
}
