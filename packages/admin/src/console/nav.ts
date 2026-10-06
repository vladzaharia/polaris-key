/**
 * The console's NAV MODEL: every page of the information architecture (docs/design/ADMIN.md §2.3),
 * declared once.
 *
 * Four places read this table and must never disagree: the sidebar (which sections and items to
 * draw), the router (which URL is which page, and whether a deep link points at a section this
 * product does not run), the top bar (section accent, the header mark's bit, the Docs link and
 * `document.title`) and the command palette. So a page is data here, not a conditional in each.
 *
 * ── Sections ──────────────────────────────────────────────────────────────────────────────────
 * One per service, in the service table's canonical order, after Core. Core is not a service:
 * product registry fields, enablement, keys, activity and settings exist for every product,
 * including one running nothing, so Core is never filtered out (an operator must always be able to
 * reach Services to turn something back on).
 *
 * ── Pages that are not built yet ──────────────────────────────────────────────────────────────
 * The table declares the whole §2.3 page set so URLs and typed builders exist from chunk 2 on. A
 * page whose redesign lands in a later area chunk carries `ready: false` and a `host`: the page
 * that holds the capability today (the Platform section's Settings opens Deployment, for
 * example). The router redirects a not-ready page to its host, and the sidebar and palette list
 * only ready pages, so every capability stays reachable and no URL is a dead end. An area chunk
 * flips `ready` and deletes `host` when it builds the page.
 *
 * The worker's docsLinks gate (packages/worker/test/docsLinks.test.ts) reads every quoted docs path
 * literal in this file and asserts the page exists in the built docs site.
 */

import {
  Activity,
  AppWindow,
  Archive,
  ArrowRightLeft,
  Blocks,
  Box,
  Boxes,
  CircleArrowUp,
  Cloud,
  CloudUpload,
  Database,
  FilePen,
  FileStack,
  Fingerprint,
  FlaskConical,
  Gauge,
  Globe,
  Grid3x3,
  HeartPulse,
  House,
  KeyRound,
  KeySquare,
  Layers,
  LayoutDashboard,
  LayoutGrid,
  ListTree,
  LockKeyhole,
  LogIn,
  MonitorSmartphone,
  Package,
  PackageOpen,
  Plug,
  PlugZap,
  Plus,
  Rocket,
  Rss,
  Send,
  Server,
  ServerCog,
  Settings,
  ShieldCheck,
  ShoppingBag,
  SquarePen,
  SlidersHorizontal,
  Stamp,
  Store,
  TrendingUp,
  UserRound,
  UsersRound,
  Waypoints,
  type LucideIcon,
} from "lucide-react";
import type { ServiceSlug } from "../api.js";
import type { ServiceAccentToken } from "../services.generated.js";

/** The `data-service` value of a section: a service slug, or `core` (BRAND.md §5). */
export type ServiceAccent = "core" | ServiceAccentToken;

/** A sidebar section's key: `core`, or the service slug that gates it. */
export type SectionKey = "core" | ServiceSlug;

/** A collapsible sidebar group: a product section, or the Platform section. */
export type NavGroupKey = SectionKey | "platform";

/** Pages that exist outside any product. */
export type GlobalPageId =
  | "home"
  | "products"
  | "product-new"
  | "platform"
  // the Platform section (notes/S-13 §9.1)
  | "platform-settings"
  | "platform-deployment"
  | "platform-operations"
  | "platform-stores"
  | "platform-feeds"
  | "platform-override-migration";

/** Pages scoped to one product (`#/p/<slug>/…`). */
export type ProductPageId =
  // core
  | "overview"
  | "services"
  | "devices"
  | "users"
  | "keys"
  | "activity"
  | "settings"
  // license
  | "licenses"
  | "tiers"
  | "enrollment"
  // config
  | "catalog"
  | "catalog-edit"
  | "profiles"
  | "edge-mint"
  // release
  | "releases"
  | "channels"
  | "deliverables"
  | "compatibility"
  | "simulator"
  | "content-keys"
  // distribution
  | "matrix"
  | "rollouts"
  | "outlets"
  | "storefronts"
  | "listing"
  | "app-store"
  | "commerce"
  | "access"
  | "package-feeds"
  | "health"
  | "credentials"
  // update
  | "feed"
  // identity
  | "portal"
  | "sign-in"
  // sync
  | "sync-data";

export type PageId = GlobalPageId | ProductPageId;

/**
 * A record under a collection page: `<path>/:id[/:tab]` (a license, a profile, a deliverable…).
 * A record is part of its collection's page: it shares the section, the sidebar item and the docs.
 */
export interface NavRecord {
  /** What one record is called, for titles and not-found copy ("License", "Profile"). */
  noun: string;
  /** The URL tabs, when the record page has them. The first is the default. */
  tabs?: readonly string[];
  /** Is the record page built? A record that is not redirects to its collection. */
  ready: boolean;
  /**
   * A record nested under this one: `<path>/:id/<segment>/:childId…[/:childTab]` (a package under
   * a feed). `ids` is how many path segments name the child (`:owner/:name` is two).
   */
  child?: NavChildRecord;
}

export interface NavChildRecord {
  segment: string;
  noun: string;
  ids: 1 | 2;
  tabs?: readonly string[];
}

/** What a nav item needs beyond its section's service (F-11: a Distribution sub-capability). */
export type NavRequirement = "packageFeeds";

/** The product facts a `requires` reads; `null` while the product is loading. */
export type NavFeatures = Partial<Record<NavRequirement, boolean>> | null;

export interface NavPage {
  page: PageId;
  /** Sidebar and palette label, sentence case. */
  label: string;
  /**
   * The path after the scope prefix: `#/p/<slug>/<path>` for a product page (`""` is the product
   * root), `#/<path>` for a global page (`""` is Home).
   */
  path: string;
  icon: LucideIcon;
  /** The docs page for this page: a site-absolute path with a trailing slash. */
  docs: string;
  /** False for sub-pages reached from their parent (the catalog editor, the simulator). */
  inNav: boolean;
  /** Is the page built in this chunk? See the file comment. */
  ready: boolean;
  /** Where the capability lives until the page is built. Required when `ready` is false. */
  host?: PageId;
  record?: NavRecord;
  /** The `g <key>` shortcut (ADMIN.md §5.5), product pages only. */
  shortcut?: string;
  /** A global page drawn inside a sidebar group rather than as a top-level link. */
  group?: "platform";
  /** Shown only while the product has this on (the page still answers a deep link). */
  requires?: NavRequirement;
}

export interface NavSection {
  key: SectionKey;
  label: string;
  /** The service that must be on for the section to exist; `null` for Core. */
  service: ServiceSlug | null;
  /** The `data-service` value: the section accent and the header mark's bit. */
  accent: ServiceAccent;
  /**
   * The section glyph (ADMIN.md §2.4): a lucide icon, or the Star Cut for Distribution, drawn
   * by the brand package. Update uses lucide `CircleArrowUp`.
   */
  glyph: LucideIcon | "star-cut";
  /** Section-level docs, the fallback for anything in the section. */
  docs: string;
  items: NavPage[];
}

/** A feed page's route tabs (F-11), the first the default. */
export const FEED_TABS = ["packages", "setup", "settings", "activity"] as const;
/** A package record's route tabs (F-11). */
export const PACKAGE_TABS = ["versions", "setup", "history"] as const;

export const SECTIONS: NavSection[] = [
  {
    key: "core",
    label: "Core",
    service: null,
    accent: "core",
    glyph: Box,
    docs: "/docs/admin/",
    items: [
      {
        page: "overview",
        label: "Overview",
        path: "",
        icon: LayoutDashboard,
        docs: "/docs/admin/products/",
        inNav: true,
        ready: true,
        shortcut: "o",
      },
      {
        page: "services",
        label: "Services",
        path: "services",
        icon: Blocks,
        docs: "/docs/admin/services-enablement/",
        inNav: true,
        ready: true,
      },
      {
        page: "devices",
        label: "Devices",
        path: "devices",
        icon: MonitorSmartphone,
        docs: "/docs/admin/licenses-and-devices/",
        inNav: true,
        ready: true,
        // The routed device drawer (`devices/:deviceId`).
        record: { noun: "Device", ready: true },
      },
      {
        // I-12: every product has users (its licence owners), whatever its Identity toggle.
        page: "users",
        label: "Users",
        path: "users",
        icon: UsersRound,
        docs: "/docs/admin/users/",
        inNav: true,
        ready: true,
        // `users/:subject[/:tab]`. `data` is reserved for the Cloud Sync Data tab (U-11a): the
        // record shows it only while Cloud Sync is on, and answers a deep link with Overview.
        record: {
          noun: "User",
          tabs: ["overview", "licenses", "devices", "activity", "data"],
          ready: true,
        },
      },
      {
        page: "keys",
        label: "Keys & secrets",
        path: "keys",
        icon: LockKeyhole,
        docs: "/docs/admin/secrets-and-keys/",
        inNav: true,
        ready: true,
      },
      {
        page: "activity",
        label: "Activity",
        path: "activity",
        icon: Activity,
        docs: "/docs/admin/activity/",
        inNav: true,
        ready: true,
        shortcut: "a",
      },
      {
        page: "settings",
        label: "Settings",
        path: "settings",
        icon: Settings,
        docs: "/docs/admin/products/",
        inNav: true,
        ready: true,
        shortcut: "s",
      },
    ],
  },
  {
    key: "license",
    label: "License",
    service: "license",
    accent: "license",
    glyph: KeyRound,
    docs: "/docs/services/license/",
    items: [
      {
        page: "licenses",
        label: "Licenses",
        path: "license/licenses",
        icon: KeyRound,
        docs: "/docs/admin/licenses-and-devices/",
        inNav: true,
        ready: true,
        shortcut: "l",
        record: {
          noun: "License",
          tabs: ["overview", "keys", "devices", "config"],
          ready: true,
        },
      },
      {
        page: "tiers",
        label: "Tiers",
        path: "license/tiers",
        icon: Layers,
        docs: "/docs/services/license/model/",
        inNav: true,
        ready: true,
        record: { noun: "Tier", tabs: ["overview", "used-by"], ready: true },
      },
      {
        page: "enrollment",
        label: "Enrollment",
        path: "license/enrollment",
        icon: Fingerprint,
        docs: "/docs/services/license/enrollment/",
        inNav: true,
        ready: true,
      },
    ],
  },
  {
    key: "config",
    label: "Config",
    service: "config",
    accent: "config",
    glyph: SlidersHorizontal,
    docs: "/docs/services/config/",
    items: [
      {
        page: "catalog",
        label: "Catalog",
        path: "config/catalog",
        icon: ListTree,
        docs: "/docs/services/config/catalog/",
        inNav: true,
        ready: true,
        shortcut: "c",
      },
      {
        page: "catalog-edit",
        label: "Edit catalog",
        path: "config/catalog/edit",
        icon: FilePen,
        docs: "/docs/services/config/catalog/",
        inNav: false,
        ready: true,
      },
      {
        page: "profiles",
        label: "Profiles",
        path: "config/profiles",
        icon: FileStack,
        docs: "/docs/services/config/profiles/",
        inNav: true,
        ready: true,
        record: {
          noun: "Profile",
          // A History tab joins these once the activity log filters by target (ADMIN.md A-2).
          tabs: ["payload", "used-by"],
          ready: true,
        },
      },
      {
        page: "edge-mint",
        label: "Edge mint",
        path: "config/edge-mint",
        icon: Stamp,
        docs: "/docs/services/config/edge-mint/",
        inNav: true,
        ready: true,
      },
    ],
  },
  {
    key: "release",
    label: "Release",
    service: "release",
    accent: "release",
    glyph: Package,
    docs: "/docs/services/release/",
    items: [
      {
        page: "releases",
        label: "Releases",
        path: "release/releases",
        icon: Rocket,
        docs: "/docs/services/release/truth-store/",
        inNav: true,
        ready: true,
        shortcut: "r",
        // The History tab joins when activity filters (A-2) can scope it to one release.
        record: {
          noun: "Release",
          tabs: ["builds", "packs", "channels", "distribution"],
          ready: true,
        },
      },
      {
        page: "channels",
        label: "Channels",
        path: "release/channels",
        icon: Waypoints,
        docs: "/docs/services/release/channels/",
        inNav: true,
        ready: true,
      },
      {
        page: "deliverables",
        label: "Deliverables",
        path: "release/deliverables",
        icon: PackageOpen,
        docs: "/docs/services/release/packs/",
        inNav: true,
        ready: true,
        record: {
          noun: "Deliverable",
          tabs: ["releases", "channels", "delivery", "files"],
          ready: true,
        },
      },
      {
        page: "compatibility",
        label: "Compatibility",
        path: "release/compatibility",
        icon: Grid3x3,
        docs: "/docs/services/release/compatibility/",
        inNav: true,
        ready: true,
      },
      {
        page: "simulator",
        label: "Update simulator",
        path: "release/compatibility/simulator",
        icon: FlaskConical,
        docs: "/docs/services/release/compatibility/",
        inNav: false,
        ready: true,
      },
      {
        page: "content-keys",
        label: "Content keys",
        path: "release/content-keys",
        icon: KeySquare,
        docs: "/docs/services/release/packs/",
        inNav: true,
        ready: true,
      },
    ],
  },
  {
    key: "distribution",
    label: "Distribution",
    service: "distribution",
    accent: "distribution",
    glyph: "star-cut",
    docs: "/docs/services/distribution/",
    items: [
      {
        page: "matrix",
        label: "Matrix",
        path: "distribution/matrix",
        icon: LayoutGrid,
        docs: "/docs/admin/distribution-matrix/",
        inNav: true,
        ready: true,
        shortcut: "m",
      },
      {
        page: "rollouts",
        label: "Rollouts",
        path: "distribution/rollouts",
        icon: TrendingUp,
        docs: "/docs/services/distribution/rollouts/",
        inNav: true,
        ready: true,
      },
      {
        page: "outlets",
        label: "Outlets & feeds",
        path: "distribution/outlets",
        icon: Store,
        docs: "/docs/services/distribution/feeds/",
        inNav: true,
        ready: true,
      },
      {
        // A-18j: every storefront's tile, and "Add to storefronts" (T6, resumable from the
        // ledger) that provisions the product onto them.
        page: "storefronts",
        label: "Storefronts",
        path: "distribution/storefronts",
        icon: Globe,
        docs: "/docs/admin/storefronts/",
        inNav: true,
        ready: true,
      },
      {
        // A-18j: the shared listing model (T3): locales, fit report, slot board, release notes,
        // and "Push listing" per store.
        page: "listing",
        label: "Listing",
        path: "distribution/listing",
        icon: SquarePen,
        docs: "/docs/admin/storefront-listing/",
        inNav: true,
        ready: true,
      },
      {
        // A-17g: the App Store Distribute flow (T6) for the product's pinned app.
        page: "app-store",
        label: "App Store",
        path: "distribution/app-store",
        icon: Send,
        docs: "/docs/admin/app-store/",
        inNav: true,
        ready: true,
      },
      {
        // A-17g: the commerce mappings beside the store's own products (App Store products, T2).
        page: "commerce",
        label: "Commerce",
        path: "distribution/commerce",
        icon: ShoppingBag,
        docs: "/docs/services/distribution/commerce/",
        inNav: true,
        ready: true,
      },
      {
        page: "access",
        label: "Access",
        path: "distribution/access",
        icon: ShieldCheck,
        docs: "/docs/services/distribution/delivery/",
        inNav: true,
        ready: true,
      },
      {
        // F-11: the product's package feeds on pkg.plrs.im, shown while `packageFeeds` is on.
        // "Package feeds", so it does not collide with "Outlets & feeds" (storefront feeds).
        page: "package-feeds",
        label: "Package feeds",
        path: "distribution/feeds",
        icon: Archive,
        docs: "/docs/admin/feeds/",
        inNav: true,
        ready: true,
        requires: "packageFeeds",
        record: {
          noun: "Feed",
          tabs: FEED_TABS,
          ready: true,
          child: {
            segment: "packages",
            noun: "Package",
            ids: 1,
            tabs: PACKAGE_TABS,
          },
        },
      },
      {
        page: "health",
        label: "Health",
        path: "distribution/health",
        icon: HeartPulse,
        docs: "/docs/services/distribution/update-health/",
        inNav: true,
        ready: true,
      },
      {
        page: "credentials",
        label: "Outlet credentials",
        path: "distribution/credentials",
        icon: Plug,
        docs: "/docs/admin/secrets-and-keys/",
        inNav: true,
        ready: true,
      },
    ],
  },
  {
    key: "update",
    label: "Update",
    service: "update",
    accent: "update",
    glyph: CircleArrowUp,
    docs: "/docs/services/update/",
    items: [
      {
        page: "feed",
        label: "Feed",
        path: "update/feed",
        icon: Rss,
        docs: "/docs/services/update/eligibility/",
        inNav: true,
        ready: true,
      },
    ],
  },
  {
    key: "identity",
    label: "Identity",
    service: "identity",
    accent: "identity",
    glyph: UserRound,
    docs: "/docs/services/identity/",
    items: [
      {
        page: "portal",
        label: "Portal",
        path: "identity/portal",
        icon: AppWindow,
        docs: "/docs/services/identity/portal/",
        inNav: true,
        ready: true,
      },
      {
        page: "sign-in",
        label: "Sign-in",
        path: "identity/sign-in",
        icon: LogIn,
        docs: "/docs/services/identity/oidc/",
        inNav: true,
        ready: true,
      },
    ],
  },
  {
    key: "sync",
    label: "Cloud Sync",
    service: "sync",
    accent: "sync",
    glyph: Cloud,
    docs: "/docs/services/sync/",
    items: [
      {
        page: "sync-data",
        label: "Data",
        path: "sync/data",
        icon: Database,
        docs: "/docs/services/sync/",
        inNav: true,
        ready: true,
      },
    ],
  },
];

/**
 * The Platform section's pages (notes/S-13 §9.1, owner decision 3 of 2026-10-04): instance-wide
 * pages that belong to no product. The sidebar draws them as one group, like a product section
 * (no header icon, an icon on every item, only the active group open, the `core` accent and no
 * section bit). The group shows only off a product (Home, Products and the Platform pages
 * themselves); inside a product it is not drawn (owner, 2026-10-04) and is reached through the
 * product switcher's Platform entry, the account menu's version chip and ⌘K. `#/platform` itself
 * is not a page: it redirects to Settings, and a page that is not built yet redirects on to
 * Deployment.
 */
const PLATFORM_PAGES: NavPage[] = [
  {
    page: "platform-settings",
    label: "Settings",
    path: "platform/settings",
    icon: ServerCog,
    docs: "/docs/admin/platform-settings/",
    inNav: true,
    ready: true,
    group: "platform",
  },
  {
    page: "platform-deployment",
    label: "Deployment",
    path: "platform/deployment",
    icon: CloudUpload,
    docs: "/docs/admin/deploy/",
    inNav: true,
    ready: true,
    group: "platform",
  },
  {
    page: "platform-operations",
    label: "Operations",
    path: "platform/operations",
    icon: Gauge,
    docs: "/docs/admin/operations/",
    inNav: true,
    ready: true,
    group: "platform",
  },
  {
    page: "platform-stores",
    label: "Store connections",
    path: "platform/store-connections",
    icon: PlugZap,
    docs: "/docs/admin/store-connections/",
    inNav: true,
    ready: true,
    group: "platform",
  },
  {
    // F-11: the platform's own package feeds (the system product's: our SDKs) and the policy.
    page: "platform-feeds",
    label: "Package feeds",
    path: "platform/feeds",
    icon: Archive,
    docs: "/docs/admin/feeds/",
    inNav: true,
    ready: true,
    group: "platform",
    record: {
      noun: "Feed",
      tabs: FEED_TABS,
      ready: true,
      // Platform scope lists every owner's packages: a package is `:owner/:name`.
      child: {
        segment: "packages",
        noun: "Package",
        ids: 2,
        tabs: PACKAGE_TABS,
      },
    },
  },
  {
    // U-03: the one-time move of licence config and secret overrides onto account overrides,
    // and its report for the 90 days after the run.
    page: "platform-override-migration",
    label: "Override migration",
    path: "platform/override-migration",
    icon: ArrowRightLeft,
    docs: "/docs/services/config/",
    inNav: true,
    ready: true,
    group: "platform",
  },
];

/** The global pages: the sidebar's platform links, the new-product wizard and the Platform section. */
export const GLOBAL_PAGES: NavPage[] = [
  {
    page: "home",
    label: "Home",
    path: "",
    icon: House,
    docs: "/docs/admin/",
    inNav: true,
    ready: true,
  },
  {
    page: "products",
    label: "Products",
    path: "products",
    icon: Boxes,
    docs: "/docs/admin/products/",
    inNav: true,
    ready: true,
  },
  {
    page: "product-new",
    label: "New product",
    path: "products/new",
    icon: Plus,
    docs: "/docs/admin/products/",
    inNav: false,
    ready: true,
  },
  {
    // The section root: always a redirect to the section's first page.
    page: "platform",
    label: "Platform",
    path: "platform",
    icon: Server,
    docs: "/docs/admin/deploy/",
    inNav: false,
    ready: false,
    host: "platform-settings",
  },
  ...PLATFORM_PAGES,
];

/** The Platform section, as the sidebar and the palette draw it. */
export const PLATFORM_GROUP = {
  key: "platform",
  label: "Platform",
  accent: "core",
  docs: "/docs/admin/deploy/",
  items: PLATFORM_PAGES,
} as const satisfies {
  key: NavGroupKey;
  label: string;
  accent: ServiceAccent;
  docs: string;
  items: NavPage[];
};

/** Every product page, in nav order. */
export const PRODUCT_PAGES: NavPage[] = SECTIONS.flatMap((s) => s.items);

/** Every page, global first. */
export const ALL_PAGES: NavPage[] = [...GLOBAL_PAGES, ...PRODUCT_PAGES];

const BY_ID = new Map<PageId, NavPage>(ALL_PAGES.map((p) => [p.page, p]));
const SECTION_OF = new Map<PageId, NavSection>(
  SECTIONS.flatMap((s) => s.items.map((i) => [i.page, s] as const)),
);

/** The declaration of a page. Total: every `PageId` is declared (a test asserts it). */
export function pageOf(id: PageId): NavPage {
  const page = BY_ID.get(id);
  if (!page) throw new Error(`nav.ts declares no page "${id}"`);
  return page;
}

/** Is this a product page (as opposed to a global one)? */
export function isProductPage(id: PageId): id is ProductPageId {
  return SECTION_OF.has(id);
}

/** The section a product page belongs to; `null` for the global pages. */
export function sectionOf(id: PageId): NavSection | null {
  return SECTION_OF.get(id) ?? null;
}

/** The accent a page carries: its section's, or `core` for the global pages (ADMIN.md §2.4). */
export function accentOf(id: PageId): ServiceAccent {
  return sectionOf(id)?.accent ?? "core";
}

/** The docs page for a page. Every page declares one; the section's is the fallback. */
export function docsFor(id: PageId): string {
  return pageOf(id).docs || sectionOf(id)?.docs || "/docs/";
}

/** What a product runs. `null` means "not loaded yet": see `isSectionEnabled`. */
export type ServiceState = Partial<
  Record<ServiceSlug, { enabled: boolean }>
> | null;

/**
 * Is this section shown for a product with this enablement?
 *
 * Core is always shown. While enablement is still loading (`null`) every section is shown: hiding
 * first and revealing later makes the nav jump under the operator's cursor, and a deep link into a
 * section this product does run would flash a service-off page first. Enablement is an affordance
 * filter here, not an access control: the worker gates every one of these endpoints itself.
 */
export function isSectionEnabled(
  section: NavSection,
  services: ServiceState,
): boolean {
  if (section.service === null) return true;
  if (services === null) return true;
  return services[section.service]?.enabled === true;
}

/** The sections to draw, in nav order. */
export function visibleSections(services: ServiceState): NavSection[] {
  return SECTIONS.filter((s) => isSectionEnabled(s, services));
}

/** Is a product page behind a service this product does not run? */
export function isPageEnabled(
  id: ProductPageId,
  services: ServiceState,
): boolean {
  const section = sectionOf(id);
  return section ? isSectionEnabled(section, services) : true;
}

/**
 * Does the product have what a page `requires`? While the product loads (`null`) a page shows,
 * like a section does (`isSectionEnabled`), and an affordance filter is all this is: the worker
 * answers every one of these endpoints itself.
 */
export function meetsRequirement(
  page: NavPage,
  features: NavFeatures,
): boolean {
  if (!page.requires || features === null) return true;
  return features[page.requires] === true;
}

/**
 * The pages a section lists in the sidebar and the palette: in nav, built, and (with `features`)
 * meeting their requirement.
 */
export function navItems(
  section: NavSection,
  features: NavFeatures = null,
): NavPage[] {
  return section.items.filter(
    (i) => i.inNav && i.ready && meetsRequirement(i, features),
  );
}

/** The global pages the sidebar lists at the top level: Home and Products. */
export function platformLinks(): NavPage[] {
  return GLOBAL_PAGES.filter((p) => p.inNav && p.ready && !p.group);
}

/** The Platform section's pages the sidebar and palette list: in nav and built. */
export function platformItems(): NavPage[] {
  return PLATFORM_GROUP.items.filter((p) => p.inNav && p.ready);
}

/** Is this one of the Platform section's pages? */
export function isPlatformPage(id: PageId): boolean {
  return pageOf(id).group === "platform";
}

/** The sidebar group a page belongs to: its product section, `platform`, or none. */
export function groupOf(id: PageId): NavGroupKey | null {
  return sectionOf(id)?.key ?? (isPlatformPage(id) ? "platform" : null);
}

/**
 * Where the product switcher lands in another product (ADMIN.md §1.3, fixes SH-11): the same page
 * when the target product runs that page's service, otherwise the target's Overview. A record id
 * and tab never carry over: they name something in the old product.
 */
export function sameViewIn(
  page: ProductPageId,
  targetServices: ServiceState,
): ProductPageId {
  return isPageEnabled(page, targetServices) ? page : "overview";
}
