import * as React from "react";
import { useLargeTextFlag } from "../../lib/useLargeTextFlag.js";
import { channelDocs, docsUrl } from "../../lib/docsLinks.js";
import { Dialog as DialogPrimitive } from "radix-ui";
import { X } from "lucide-react";
import { type Me } from "../../api.js";
import { PageSkeleton, type SkeletonTemplate } from "../../ui/Skeleton.js";
import { TooltipProvider } from "../../ui/Tooltip.js";
import { usePlatformVersion, useProduct, useProducts } from "../data/hooks.js";
import {
  accentOf,
  docsFor,
  groupOf,
  isPageEnabled,
  isPlatformPage,
  navFeaturesOf,
  isProductPage,
  pageOf,
  PRODUCT_PAGES,
  sectionOf,
  visibleSections,
  type GlobalPageId,
  type NavFeatures,
  type PageId,
  type ProductPageId,
  type ServiceState,
} from "../nav.js";
import { navigate, useLocation } from "../router.js";
import { portalHandOff } from "../portalHandOff.js";
import {
  opensRecordInDrawer,
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
import { Home } from "../sections/global/pages/Home.js";
import { ProductNew } from "../sections/global/pages/ProductNew.js";
import { ApiTokens } from "../sections/global/pages/ApiTokens.js";
import { SignInMethods } from "../sections/account/SignInMethods.js";
import { PersonalTokens } from "../sections/global/pages/PersonalTokens.js";
import { Announcer } from "../../ui/LiveRegion.js";
import { focusRoute } from "../../ui/focusRoute.js";
import { Button } from "../../ui/Button.js";
import { Callout } from "../../ui/Callout.js";
import { formatSessionEnd } from "./UserMenu.js";
import type { ProductLike } from "./bits.js";
import { OPEN_PALETTE_EVENT } from "../shortcuts.js";
import { CommandPalette } from "./CommandPalette.js";
import { navigationSource, productSource } from "./palette/navigation.js";
import { PageErrorBoundary } from "./PageErrorBoundary.js";
import { ShortcutSheet } from "./ShortcutSheet.js";
import { Sidebar, useNavCollapse } from "./Sidebar.js";
import {
  MovedPage,
  ChannelOutOfScopePage,
  NotFoundPage,
  ServiceOffPage,
  UnknownProductPage,
} from "./StatePages.js";
import { TopBar } from "./TopBar.js";
import { mastheadValue } from "./Masthead.js";
import { MastheadContext } from "../../ui/Masthead.js";
import { mutate } from "../../console/data/mutations.js";
import {
  areaOfPage,
  canIn,
  canOpenHref,
  canOpenPage,
  landingPage,
} from "../access/can.js";
import { NoAccessPage } from "../access/NoAccessPage.js";
import { HrefAccess, LandingAccess } from "../access/context.js";

/** The Platform section's pages: one lazy chunk (notes/S-13 §9.1). */
const PlatformPages = React.lazy(() => import("../sections/platform/index.js"));

/** Where the sidebar is part of the layout and the mobile drawer has no place. */
export const DESKTOP_QUERY = "(min-width: 1024px)";

/** The top bar's menu button, which the mobile drawer returns focus to. */
export const NAV_BUTTON_ID = "console-nav-button";

/** The title of the page a route shows, without the product (ADMIN.md §2.6 `document.title`). */
export function pageTitle(route: Route): string {
  if (route.kind === "not-found")
    return route.moved ? "Page moved" : "Page not found";
  const page = pageOf(route.page);
  if (route.child && page.record?.child) {
    return `${page.record.child.noun} ${route.child.ids[route.child.ids.length - 1]}`;
  }
  if (route.page === "storefronts" && route.id === "polaris-key")
    return "Polaris Locker";
  // A drawer over the list keeps the list's title: the route focus and scroll stay where they are.
  if (
    route.id !== undefined &&
    page.record &&
    !(route.kind === "global" && opensRecordInDrawer(route.page))
  ) {
    return `${page.record.noun} ${route.id}`;
  }
  return page.label;
}

/** Is this route a page the member's role does not include (so NoAccessPage shows)? */
function knownProductPageRefused(me: Me, route: Route): boolean {
  if (route.kind === "global") return !canOpenPage(me, route.page, null);
  if (route.kind !== "product") return false;
  return (
    me.products.some((p) => p.slug === route.slug) &&
    isProductPage(route.page) &&
    !canOpenPage(me, route.page, route.slug)
  );
}

/** `"{page title} · {product} · Polaris Key Console"`, or `"{page title} · Polaris Key Console"` off a product. */
export function documentTitle(
  route: Route,
  productName: string | null,
  refused = false,
): string {
  return [
    refused ? `No access · ${pageTitle(route)}` : pageTitle(route),
    productName,
    "Polaris Key Console",
  ]
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
 * After a navigation: scroll back to the top (owner, 2026-10-03), then `focusRoute` moves focus to
 * the page's `<h1>` and announces "{title}, page loaded" (ADMIN.md §5.6) through the shared
 * `<Announcer/>`. `key` changes with the page or record, not with its query string, so filtering
 * a list never jumps. The first render is left alone, so the skip link stays the first stop.
 */
function useRouteFocus(key: string, title: string): void {
  const first = React.useRef(true);
  React.useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const main = document.getElementById("content");
    // The page scrolls inside <main>; reset it and the window, in case a layout scrolls the body.
    if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
    if (!main) return;
    main.scrollTop = 0;
    let alive = true;
    void focusRoute({ title, root: main, alive: () => alive });
    return () => {
      alive = false;
    };
  }, [key, title]);
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
  // Large text lets a console button label wrap (the `cramped` variant, styles.css).
  useLargeTextFlag("data-console-large-text");
  const { route } = useLocation();
  const page = pageOfRoute(route);
  const handOff = portalHandOff(
    route,
    typeof window === "undefined" ? "" : window.location.hash,
    me.customerOrigin,
  );
  React.useEffect(() => {
    if (handOff) window.location.replace(handOff);
  }, [handOff]);
  const routeSlug = slugOfRoute(route);
  const knownProduct =
    routeSlug !== null && me.products.some((p) => p.slug === routeSlug);
  const slug = knownProduct ? routeSlug : null;

  const productQuery = useProduct(slug);
  const products = useProducts();
  const services: ServiceState = productQuery.data?.services ?? null;
  const features: NavFeatures = navFeaturesOf(productQuery.data);
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
  // The page the product switcher keeps. A not-found page under a known product keeps the
  // product's chrome (switcher and sidebar); switching from it lands on the other's Overview.
  const switcherPage: ProductPageId | null =
    productPageId ?? (slug !== null ? "overview" : null);

  // The section rides <html> too, so what Radix portals out of this tree (dialogs, menus) takes
  // the section's accent, and the header mark's bit follows the route (BRAND.md §6).
  React.useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-service", accent);
    return () => root.removeAttribute("data-service");
  }, [accent]);
  // The console's chrome rules (neutral-ink primary B2, the focus ring in the service's accent
  // B17) are scoped to this attribute in styles.css, so the portal that shares the sheet keeps
  // its own until its packages (PX-27..32) adopt them.
  React.useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-shell", "console");
    return () => root.removeAttribute("data-shell");
  }, []);
  // A page the member's role does not include renders NoAccessPage, so its title says so.
  const refused =
    (route.kind === "product" || route.kind === "global") &&
    page !== null &&
    knownProductPageRefused(me, route);
  const masthead = React.useMemo(
    () =>
      mastheadValue({
        route,
        page,
        accent,
        product,
        platform: canIn(me, "platform"),
        refused,
      }),
    [route, page, accent, product, me, refused],
  );

  const title = documentTitle(
    route,
    routeSlug && knownProduct ? productName : null,
    refused,
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
  const drawerRef = React.useRef<HTMLDivElement>(null);
  const drawerSwitcherRef = React.useRef(false);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  // What the palette opens already searching for: a not-found page's dead segment, else nothing.
  const [paletteQuery, setPaletteQuery] = React.useState("");
  const openPalette = React.useCallback((query = "") => {
    setPaletteQuery(query);
    setPaletteOpen(true);
  }, []);
  // A page asks for the palette with a query already typed (`openPaletteWith`, `shortcuts.tsx`).
  React.useEffect(() => {
    const on = (e: Event): void =>
      openPalette(String((e as CustomEvent<string>).detail ?? ""));
    window.addEventListener(OPEN_PALETTE_EVENT, on);
    return () => window.removeEventListener(OPEN_PALETTE_EVENT, on);
  }, [openPalette]);
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const [switcherOpen, setSwitcherOpen] = React.useState(false);
  const switcherOpener = React.useRef<HTMLElement | null>(null);
  // The drawer's own switcher, for `g p` below the desktop breakpoint.
  const [drawerSwitcherOpen, setDrawerSwitcherOpen] = React.useState(false);
  drawerSwitcherRef.current = drawerSwitcherOpen;
  // A refused or unknown page holds no section: open every group the member can use if there are
  // three or fewer, else the first, so the way out is in view.
  const openable =
    refused && slug !== null
      ? visibleSections(services)
          .filter((sec) => sec.key !== "core")
          .filter((sec) =>
            sec.items.some((item) => canOpenPage(me, item.page, slug)),
          )
          .map((sec) => sec.key)
      : [];
  const { expanded, toggle } = useNavCollapse(
    group,
    openable.length <= 3 ? openable : openable.slice(0, 1),
  );
  const version = usePlatformVersion(canIn(me, "platform"));

  const key = viewKey(route);
  const keyRef = React.useRef(key);
  keyRef.current = key;
  // The route the drawer opened on: a different one at close means the page heading has focus.
  const openedAt = React.useRef(key);
  React.useEffect(() => {
    if (navOpen) openedAt.current = keyRef.current;
    else setDrawerSwitcherOpen(false);
  }, [navOpen]);
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
  useRouteFocus(
    key,
    refused ? `No access · ${pageTitle(route)}` : pageTitle(route),
  );

  useGlobalShortcuts({
    openPalette: () => openPalette(),
    togglePalette: () => {
      setPaletteQuery("");
      setPaletteOpen((o) => !o);
    },
    openSheet: () => setSheetOpen(true),
    toggleSidebar: toggleRail,
    go: (k) => {
      if (k === "h") return navigate(r.home());
      if (k === "p") {
        const desktop =
          typeof window.matchMedia !== "function" ||
          window.matchMedia(DESKTOP_QUERY).matches;
        if (desktop) {
          // Escape from the switcher goes back to where `g p` was pressed (B-006).
          switcherOpener.current = document.activeElement as HTMLElement | null;
          setSwitcherOpen(true);
        } else {
          // The desktop sidebar is hidden here: open the drawer with its switcher.
          setNavOpen(true);
          setDrawerSwitcherOpen(true);
        }
        return true;
      }
      if (!slug) return false;
      const target = PRODUCT_PAGES.find((p) => p.shortcut === k);
      if (
        !target ||
        !isPageEnabled(target.page as ProductPageId, services) ||
        !canOpenPage(me, target.page, slug)
      )
        return false;
      return navigate(productPage(slug, target.page as ProductPageId));
    },
  });

  // ST-29: what the member's role opens, for the lists below the shell (attention).
  const canOpenHrefForMe = React.useCallback(
    (href: string) => canOpenHref(me, href),
    [me],
  );

  // Where a link to a product opens for this member: Overview, unless their role is narrowed.
  const landing = React.useCallback(
    (productSlug: string, svc: ServiceState) =>
      landingPage(me, productSlug, svc),
    [me],
  );

  const signOut = (): void => {
    void mutate("logout").finally(() => {
      window.location.href = "/manage/login?signedOut=1";
    });
  };

  const paletteItems = [
    ...navigationSource(slug, productName, services, features),
    ...productSource(productList, landing),
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
    // ST-29: what the member cannot open is absent from the sidebar, not disabled.
    canOpen: (id: PageId) => canOpenPage(me, id, slug),
  };
  // The context header's switcher: the product in scope, or Platform off a product.
  const switcherContext = {
    products: productList,
    current: slug ? product : null,
    page: switcherPage,
    platform: canIn(me, "platform"),
    returnFocusTo: switcherOpener,
  };

  return (
    <HrefAccess.Provider value={canOpenHrefForMe}>
      <LandingAccess.Provider value={landing}>
        <TooltipProvider delayDuration={300}>
          <>
            <div
              data-service={accent}
              style={
                {
                  "--sidebar-w": rail ? "3.5rem" : "15rem",
                } as React.CSSProperties
              }
              className="relative grid h-dvh grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-surface-page text-fg lg:grid-cols-[var(--sidebar-w)_minmax(0,1fr)]"
            >
              <a
                href="#content"
                onClick={(e) => {
                  e.preventDefault();
                  document.getElementById("content")?.focus();
                }}
                className="sr-only z-50 rounded-md bg-surface-overlay px-3 py-2 text-sm font-medium focus:not-sr-only focus:fixed focus:start-3 focus:top-3 focus-visible:outline-2 focus-visible:outline-focus"
              >
                Skip to content
              </a>
              <TopBar
                className="lg:col-span-2"
                me={me}
                section={accent}
                navOpen={navOpen}
                docsHref={
                  page === "channel"
                    ? channelDocs("id" in route ? route.id : undefined)
                    : page
                      ? docsFor(page)
                      : docsUrl("consoleDocsHome")
                }
                onOpenPalette={() => openPalette()}
                onOpenNav={() => setNavOpen(true)}
                onShortcuts={() => setSheetOpen(true)}
                onSignOut={signOut}
                version={version.data ?? null}
              />
              <aside className="hidden min-h-0 flex-col bg-surface-page lg:flex">
                <Sidebar
                  {...sidebarProps}
                  switcher={{
                    ...switcherContext,
                    open: switcherOpen,
                    onOpenChange: setSwitcherOpen,
                  }}
                  rail={rail}
                  onToggleRail={toggleRail}
                  idPrefix="sidebar"
                />
              </aside>
              <main
                id="content"
                tabIndex={-1}
                // The phone drawer is modal: the page behind it is inert while it is open.
                inert={navOpen || undefined}
                data-canvas=""
                data-service={accent}
                data-edge="canvas"
                // The canvas (B4): raised, with a 3 px rule in the page's accent along its top edge.
                // From 1024 px it is inset 16 px from the window's end and bottom and rounded 18 px;
                // below that it runs edge to edge. Flat: no glow, wash or gradient.
                className="relative min-h-0 overflow-y-auto border-t-[3px] border-accent bg-surface-raised outline-hidden pk-scroll lg:mb-4 lg:me-4 lg:rounded-[18px] lg:border lg:border-t-[3px] lg:border-border lg:border-t-accent"
              >
                <div
                  data-service={accent}
                  className="mx-auto w-full max-w-[110rem] px-4 py-4 sm:px-6"
                >
                  {me.breakGlass ? (
                    // ST-30c.2 (D-S7): an emergency session names no account and lasts an hour.
                    <div
                      role="region"
                      aria-label="Emergency sign-in"
                      className="mb-4"
                    >
                      <Callout
                        tone="warning"
                        action={
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={signOut}
                          >
                            Sign out
                          </Button>
                        }
                      >
                        {me.sessionExpiresAt
                          ? `You're using emergency sign-in until ${formatSessionEnd(me.sessionExpiresAt)}. Sign out when you're done.`
                          : "You're using emergency sign-in. Sign out when you're done."}
                      </Callout>
                    </div>
                  ) : null}
                  <MastheadContext.Provider value={masthead}>
                    <PageContent
                      key={key}
                      route={route}
                      me={me}
                      knownProduct={knownProduct}
                      services={services}
                      features={features}
                      productLoading={
                        productQuery.isPending || productQuery.isPlaceholderData
                      }
                      productName={productName ?? routeSlug ?? ""}
                      onOpenPalette={openPalette}
                    />
                  </MastheadContext.Provider>
                </div>
              </main>
            </div>

            <DialogPrimitive.Root open={navOpen} onOpenChange={setNavOpen}>
              <DialogPrimitive.Portal>
                <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-(--polaris-key-page-dark)/50 animate-pk-overlay-in lg:hidden" />
                <DialogPrimitive.Content
                  ref={drawerRef}
                  aria-describedby={undefined}
                  onOpenAutoFocus={(e) => {
                    // Opening moves focus to the first item, not the close button.
                    e.preventDefault();
                    // Opened for `g p`: the switcher's popover takes focus, not the list.
                    if (drawerSwitcherRef.current) return;
                    const content = drawerRef.current;
                    if (!content) return;
                    // The current row when there is one (the list is already scrolled to it),
                    // else the first; never scrolled away from it.
                    (
                      content.querySelector<HTMLElement>(
                        "[data-nav-list] [aria-current=page]",
                      ) ??
                      content.querySelector<HTMLElement>("[data-nav-list] a") ??
                      content.querySelector<HTMLElement>("button")
                    )?.focus({ preventScroll: true });
                  }}
                  onCloseAutoFocus={(e) => {
                    // The drawer is opened from the top bar, not a Radix trigger: hand focus back,
                    // unless the route changed: then the page heading has focus.
                    e.preventDefault();
                    if (openedAt.current !== keyRef.current) return;
                    const button = document.getElementById(NAV_BUTTON_ID);
                    // Widened past the drawer: the button is `lg:hidden`, so focus would drop to
                    // <body>. The desktop sidebar's current link (else the content) takes it.
                    const desktop =
                      typeof window.matchMedia === "function" &&
                      window.matchMedia(DESKTOP_QUERY).matches;
                    if (!button || desktop) {
                      (
                        document.querySelector<HTMLElement>(
                          "aside [data-nav-list] [aria-current=page]",
                        ) ?? document.getElementById("content")
                      )?.focus({ preventScroll: true });
                      return;
                    }
                    button.focus();
                  }}
                  className="fixed inset-y-0 start-0 z-50 flex w-72 max-w-[85%] flex-col border-e border-border bg-surface-page pt-[env(safe-area-inset-top,0px)] shadow-elevation-3 animate-pk-in pk-nav-drawer lg:hidden"
                >
                  <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
                    <DialogPrimitive.Title className="text-sm font-semibold text-fg-strong">
                      Navigation
                    </DialogPrimitive.Title>
                    <DialogPrimitive.Close
                      aria-label="Close navigation"
                      className="rounded-md p-1.5 text-fg-muted hover:bg-hover hover:text-fg-strong focus-visible:outline-2 focus-visible:outline-focus"
                    >
                      <X aria-hidden className="size-4" />
                    </DialogPrimitive.Close>
                  </div>
                  <Sidebar
                    {...sidebarProps}
                    switcher={{
                      ...switcherContext,
                      open: drawerSwitcherOpen,
                      onOpenChange: setDrawerSwitcherOpen,
                      onNavigate: () => setNavOpen(false),
                    }}
                    idPrefix="drawer"
                    onNavigate={() => setNavOpen(false)}
                  />
                </DialogPrimitive.Content>
              </DialogPrimitive.Portal>
            </DialogPrimitive.Root>

            <CommandPalette
              me={me}
              open={paletteOpen}
              onOpenChange={setPaletteOpen}
              initialQuery={paletteQuery}
              items={paletteItems}
            />
            <ShortcutSheet open={sheetOpen} onOpenChange={setSheetOpen} />
            <Announcer />
          </>
        </TooltipProvider>
      </LandingAccess.Provider>
    </HrefAccess.Provider>
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
  if (route.page === "overview" || route.page === "platform-status")
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
  if (page === "api-tokens") return <ApiTokens />;
  if (page === "personal-tokens") return <PersonalTokens />;
  if (page === "sign-in-methods") return <SignInMethods />;
  if (page === "product-new") return <ProductNew />;
  return <Home />;
}

/** What the main column shows for a route: a state page, a global page or a section page. */
function PageContent({
  route,
  me,
  knownProduct,
  services,
  features,
  productLoading,
  productName,
  onOpenPalette,
}: {
  route: Route;
  me: Me;
  knownProduct: boolean;
  services: ServiceState;
  features: NavFeatures;
  /** The one-product read is not in yet (the list row may stand in): the channel facts are unknown. */
  productLoading: boolean;
  productName: string;
  onOpenPalette: (query?: string) => void;
}): React.ReactElement {
  if (route.kind === "not-found") {
    if (route.slug && !me.products.some((p) => p.slug === route.slug)) {
      return <UnknownProductPage slug={route.slug} products={me.products} />;
    }
    if (route.moved) {
      return (
        <MovedPage
          path={route.path}
          slug={route.slug}
          moved={route.moved}
          query={route.query}
          onOpenPalette={onOpenPalette}
        />
      );
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
    // ST-29: a member who holds no product yet (and not the platform) gets Home's no-access
    // state; any other page the member lacks the area of is NoAccessPage.
    if (
      route.page === "home" &&
      me.products.length === 0 &&
      !canIn(me, "platform")
    )
      return <NoAccessPage me={me} area="console" slug={null} home />;
    if (!canOpenPage(me, route.page, null))
      return <NoAccessPage me={me} area={areaOfPage(route.page)} slug={null} />;
    return <PageErrorBoundary>{globalPageFor(route)}</PageErrorBoundary>;
  }
  // `/me` lists every product the member holds an area of, so a slug outside it is unknown here:
  // the console never says whether a product it does not show exists.
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
  // ST-29: a product the member holds, but not this page's area. The worker refuses the page's
  // routes whatever this shows; NoAccessPage says who can help instead of a failed load.
  if (!canOpenPage(me, route.page, route.slug)) {
    return (
      <NoAccessPage
        me={me}
        area={areaOfPage(route.page)}
        slug={route.slug}
        productName={productName}
        services={services}
      />
    );
  }
  const section = sectionOf(route.page)!;
  // Commerce Overview draws its own off view: it still lists the storefronts and the store
  // purchases that arrive while Commerce is off (the Attention state), so the shell does not
  // replace it with the generic page.
  if (
    route.page !== "commerce-overview" &&
    !isPageEnabled(route.page, services)
  ) {
    return (
      <ServiceOffPage
        section={section}
        slug={route.slug}
        productName={productName}
      />
    );
  }
  // A-20.7: a link to a page of a store outside the product's scope says so, not a bare page.
  const target = PRODUCT_PAGES.find((p) => p.page === route.page);
  const needs = target?.requires;
  // Until the product's facts are in (the list row stands in as placeholder data, without them), a
  // channel page shows its loading state: the real page would flash, with the opposite advice,
  // and fire its reads.
  if (needs?.startsWith("channel:") && (features === null || productLoading))
    return <PageLoading route={route} />;
  if (needs?.startsWith("channel:") && features?.[needs] === false) {
    return (
      <ChannelOutOfScopePage
        section={section}
        title={target!.label}
        slug={route.slug}
        channel={needs.slice("channel:".length)}
      />
    );
  }
  const Pages = sectionPages(section.key);
  return (
    <React.Suspense fallback={<PageLoading route={route} />}>
      <PageErrorBoundary>
        <Pages route={route} />
      </PageErrorBoundary>
    </React.Suspense>
  );
}
