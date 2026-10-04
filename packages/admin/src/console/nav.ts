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
 * that holds the capability today (Edge mint still lives inside Keys & secrets until chunk 7, for
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
  Blocks,
  Box,
  Boxes,
  CloudUpload,
  FilePen,
  FileStack,
  Fingerprint,
  FlaskConical,
  Gauge,
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
  Server,
  ServerCog,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Stamp,
  Store,
  TrendingUp,
  UserRound,
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
  | "platform-feeds";

/** Pages scoped to one product (`#/p/<slug>/…`). */
export type ProductPageId =
  // core
  | "overview"
  | "services"
  | "devices"
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
  | "access"
  | "health"
  | "credentials"
  // update
  | "feed"
  // identity
  | "portal"
  | "sign-in";

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
}

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
}

export interface NavSection {
  key: SectionKey;
  label: string;
  /** The service that must be on for the section to exist; `null` for Core. */
  service: ServiceSlug | null;
  /** The `data-service` value: the section accent and the header mark's bit. */
  accent: ServiceAccent;
  /**
   * The section glyph (ADMIN.md §2.4): a lucide icon, or the Star Cut for the delivery family
   * (Distribution and Update), drawn by the brand package.
   */
  glyph: LucideIcon | "star-cut";
  /** Section-level docs, the fallback for anything in the section. */
  docs: string;
  items: NavPage[];
}

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
        // The routed device drawer arrives with the Devices rebuild (chunk 5).
        record: { noun: "Device", ready: false },
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
          tabs: ["overview", "keys", "devices", "config", "history"],
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
        record: { noun: "Tier", ready: false },
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
        ready: false,
        host: "catalog",
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
          tabs: ["payload", "used-by", "history"],
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
        // Mounted inside Keys & secrets until the Config chunk (7) moves it.
        ready: false,
        host: "keys",
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
        record: {
          noun: "Release",
          tabs: ["builds", "packs", "channels", "history"],
          ready: false,
        },
      },
      {
        page: "channels",
        label: "Channels",
        path: "release/channels",
        icon: Waypoints,
        docs: "/docs/services/release/channels/",
        inNav: true,
        // The channels panel is part of Releases until the Release chunk (8) promotes it.
        ready: false,
        host: "releases",
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
        ready: false,
        host: "compatibility",
      },
      {
        page: "content-keys",
        label: "Content keys",
        path: "release/content-keys",
        icon: KeySquare,
        docs: "/docs/services/release/packs/",
        inNav: true,
        // Part of Deliverables until the Release chunk (8) moves it (DLV-5).
        ready: false,
        host: "deliverables",
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
        // Today's Distribution overview (chain, rollouts, hooks) until chunk 9 rebuilds it.
        ready: true,
      },
      {
        page: "outlets",
        label: "Outlets & feeds",
        path: "distribution/outlets",
        icon: Store,
        docs: "/docs/services/distribution/feeds/",
        inNav: true,
        // A capability with no console UI yet (chunk 9).
        ready: false,
        host: "matrix",
      },
      {
        page: "access",
        label: "Access",
        path: "distribution/access",
        icon: ShieldCheck,
        docs: "/docs/services/distribution/delivery/",
        inNav: true,
        // Delivery access lives in Update → Feed until chunk 9 moves it.
        ready: false,
        host: "feed",
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
        // Mounted inside Keys & secrets until chunk 9 moves it.
        ready: false,
        host: "keys",
      },
    ],
  },
  {
    key: "update",
    label: "Update",
    service: "update",
    accent: "update",
    glyph: "star-cut",
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
        // The OIDC card is part of Portal until the Identity chunk (10) splits it.
        ready: false,
        host: "portal",
      },
    ],
  },
];

/**
 * The Platform section's pages (notes/S-13 §9.1, owner decision 3 of 2026-10-04): instance-wide
 * pages that belong to no product. The sidebar draws them as one group, like a product section
 * (no header icon, an icon on every item, only the active group open, the `core` accent and no
 * section bit), whether or not a product is in scope. `#/platform` itself is not a page: it
 * redirects to Settings, and a page that is not built yet redirects on to Deployment.
 */
const PLATFORM_PAGES: NavPage[] = [
  {
    page: "platform-settings",
    label: "Settings",
    path: "platform/settings",
    icon: ServerCog,
    docs: "/docs/admin/kek/",
    inNav: true,
    // The settings store (A-13) and its page (4P-1) land later; until then, Deployment.
    ready: false,
    host: "platform-deployment",
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
    docs: "/docs/admin/deploy/",
    inNav: true,
    // Self-reported operations data (A-14) and its page (4P-3) land later.
    ready: false,
    host: "platform-deployment",
    group: "platform",
  },
  {
    page: "platform-stores",
    label: "Store connections",
    path: "platform/store-connections",
    icon: PlugZap,
    docs: "/docs/services/distribution/",
    inNav: true,
    ready: false,
    host: "platform-deployment",
    group: "platform",
  },
  {
    page: "platform-feeds",
    label: "Package feeds",
    path: "platform/feeds",
    icon: Archive,
    docs: "/docs/services/distribution/feeds/",
    inNav: true,
    // S-12 owns the page and its API.
    ready: false,
    host: "platform-deployment",
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

/** The pages a section lists in the sidebar and the palette: in nav and built. */
export function navItems(section: NavSection): NavPage[] {
  return section.items.filter((i) => i.inNav && i.ready);
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
