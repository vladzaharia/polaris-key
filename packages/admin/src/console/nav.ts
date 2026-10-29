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
 * ── Section roots ─────────────────────────────────────────────────────────────────────────────
 * A section's key alone (`#/p/<slug>/license`, `#/platform`) is not a page: the router sends it to
 * the section's first listed page (`routes.ts`).
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
  Cable,
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
  Image,
  HeartPulse,
  History,
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
  Radar,
  Rocket,
  Rss,
  Server,
  ServerCog,
  Settings,
  ShieldCheck,
  ShoppingBag,
  SquarePen,
  SlidersHorizontal,
  Store,
  TrendingUp,
  UserRound,
  UsersRound,
  Waypoints,
  type LucideIcon,
} from "lucide-react";
import { CHANNEL_IDS, type ChannelId } from "@polaris-key/manifest";
import type { ProductDetail, ServiceSlug } from "../api.js";
import {
  FEATURES,
  type FeatureRow,
  type ServiceAccentToken,
} from "../services.generated.js";

/** The `data-service` value of a section: a service slug, or `core` (BRAND.md §5). */
export type ServiceAccent = "core" | ServiceAccentToken;

/** A sidebar section's key: `core`, or the service slug that gates it. */
export type SectionKey = "core" | ServiceSlug;

/** The sections that make up Ship builds, one sidebar group (B5). */
export const SHIP_BUILDS_KEYS: readonly SectionKey[] = [
  "release",
  "distribution",
  "update",
];

/** A collapsible sidebar group: a product section, or the Platform section. */
export type NavGroupKey = SectionKey | "platform";

/** Pages that exist outside any product. */
export type GlobalPageId =
  | "home"
  | "product-new"
  // the deployment's admin API tokens: a credential store that belongs to no product or service
  | "api-tokens"
  // people's personal tokens (`pkeyp_`): the Superadmin's roster and revoke
  | "personal-tokens"
  // the signed-in operator's own sign-in methods, reached from the account menu (ST-30c.4)
  | "sign-in-methods"
  // the Platform section (notes/S-13 §9.1)
  | "platform-settings"
  | "platform-members"
  | "platform-status"
  | "platform-stores"
  | "platform-connections"
  | "platform-feeds"
  | "platform-activity";

/** Pages scoped to one product (`#/p/<slug>/…`). */
export type ProductPageId =
  // core
  | "overview"
  | "integration"
  | "services"
  | "devices"
  | "users"
  | "presentation"
  | "portal"
  | "keys"
  | "activity"
  | "settings"
  | "settings-members"
  | "settings-all"
  // license
  | "licenses"
  | "tiers"
  | "enrollment"
  | "license-settings"
  | "license-batches"
  // config
  | "catalog"
  | "catalog-edit"
  | "profiles"
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
  | "presentation-listing"
  | "channel"
  | "commerce"
  | "access"
  | "package-feeds"
  | "health"
  | "credentials"
  // update
  | "feed"
  // identity
  | "app-sign-in"
  // sync
  | "sync-setup"
  | "sync-usage"
  | "sync-data"
  // connect
  | "connect-setup"
  | "connect-devices"
  | "connect-usage"
  // commerce
  | "commerce-overview";

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

/**
 * What a nav item needs beyond its section's service: a channel in the product's scope (A-20.7:
 * its platforms and deliverables fit the channel). Packages needs nothing beyond Distribution
 * (F-34.7): the package-feeds switch is a state of its page, not a reason to hide it.
 */
export type NavRequirement = `channel:${ChannelId}`;

/** The product facts a `requires` reads; `null` while the product is loading. */
export type NavFeatures = Partial<Record<NavRequirement, boolean>> | null;

/** The requirement that names a channel. */
export const channelRequirement = (id: string): NavRequirement =>
  `channel:${id as ChannelId}`;

/**
 * The nav's facts from a one-product read. The Worker lists a channel when it is in scope or the
 * team declared it (an out-of-scope declared one stays, flagged), so a listed channel stays and
 * an unlisted one is out. A product with no platform facts has an unknown scope, not an empty
 * one: it leaves the channels unset, which shows every page as before.
 */
export function navFeaturesOf(
  product: Pick<ProductDetail, "channels" | "platforms"> | null | undefined,
): NavFeatures {
  if (!product) return null;
  const features: Partial<Record<NavRequirement, boolean>> = {};
  if (product.channels && (product.platforms?.length ?? 0) > 0) {
    const listed = new Set(product.channels.map((c) => c.id));
    for (const id of CHANNEL_IDS)
      features[channelRequirement(id)] = listed.has(id);
  }
  return features;
}

/** Is this channel in the product's scope? True while the facts load or are not sent. */
export function channelInScope(features: NavFeatures, id: string): boolean {
  return features === null || features[channelRequirement(id)] !== false;
}

export interface NavPage {
  page: PageId;
  /** Sidebar and palette label, sentence case. */
  label: string;
  /**
   * The palette's label when the sidebar's would be ambiguous there (the palette lists every
   * section's pages in one list: License → Settings is "Licensing", Core's stays "Settings").
   * Kept in the keywords, so typing the sidebar label still finds it.
   */
  paletteLabel?: string;
  /** More words the palette matches the page on ("matrix" finds Rollouts, which shows it). */
  keywords?: string;
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
  record?: NavRecord;
  /** The `g <key>` shortcut (ADMIN.md §5.5), product pages only. */
  shortcut?: string;
  /** Where the shortcut lands, when not this page's label: the sheet's "Go to <it>". */
  shortcutLabel?: string;
  /** A global page drawn inside a sidebar group rather than as a top-level link. */
  group?: "platform";
  /** Shown only while the product has this on (the page still answers a deep link). */
  requires?: NavRequirement;
  /**
   * The page's own `data-service`, when it is not its section's (B5, B17): Ship builds is one
   * Release identity, but Storefronts, Listing, App Store and Outlet credentials are sales
   * surfaces and keep Distribution green. Absent, the section's accent.
   */
  accent?: ServiceAccent;
  /**
   * The masthead's 48 px tile at 1024 px and wider (B4): the product's icon on a product Core
   * page, the feature's glyph on its accent on a feature landing page. Absent on a dense data
   * page (a table, a record, a form), which has the orientation chip only.
   */
  tile?: "product" | "service";
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
   * by the brand package.
   */
  glyph: LucideIcon | "star-cut";
  /** Section-level docs, the fallback for anything in the section. */
  docs: string;
  items: NavPage[];
}

/**
 * The product settings hub's areas, in tab order (ST-08, `#/p/<slug>/settings/<area>`). Each is a
 * product page of Core; only `settings` (General) is a sidebar item, and the rest are its tabs.
 */
/** The hub tab a hub page sits under, when it is not a tab itself (the trail "Settings → Presentation → Listing"). */
export const SETTINGS_TAB_OF: Partial<Record<ProductPageId, ProductPageId>> = {
  "presentation-listing": "presentation",
};

export const SETTINGS_HUB_PAGES: readonly ProductPageId[] = [
  "settings",
  "services",
  "presentation",
  "presentation-listing",
  "portal",
  "keys",
  "settings-members",
  "settings-all",
];

/** Cloud Sync's route tabs, the first the default; one sidebar row, `sync-setup`. */
export const SYNC_PAGES: readonly ProductPageId[] = [
  "sync-setup",
  "sync-usage",
  "sync-data",
];

/** Cloud Connect's route tabs, the first the default; one sidebar row, `connect-setup`. */
export const CONNECT_PAGES: readonly ProductPageId[] = [
  "connect-setup",
  "connect-usage",
  "connect-devices",
];

/**
 * A channel page's route tabs (A-22), the first the default. The URL knows every tab the page will
 * have; the page shows the ones that are built (`channelTabs.ts`).
 */
export const CHANNEL_TAB_IDS = [
  "status",
  "releases",
  "listing",
  "sales",
  "setup",
] as const;

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
    docs: "/docs/operate/",
    items: [
      {
        page: "overview",
        tile: "product",
        label: "Overview",
        path: "",
        icon: LayoutDashboard,
        docs: "/docs/operate/console/products/",
        inNav: true,
        shortcut: "o",
      },
      {
        // ST-41: per feature, what the app needs and where it was seen working.
        page: "integration",
        tile: "product",
        label: "Integration",
        path: "integration",
        icon: Cable,
        docs: "/docs/build/test-your-integration/",
        inNav: true,
      },
      {
        page: "services",
        tile: "product",
        label: "Features and general",
        path: "settings/features",
        icon: Blocks,
        docs: "/docs/operate/console/products/",
        // A tab of the settings hub (ST-08), not a sidebar item.
        inNav: false,
      },
      {
        page: "devices",
        label: "Devices",
        path: "devices",
        icon: MonitorSmartphone,
        docs: "/docs/features/licensing/manage-licenses/",
        inNav: true,
        // The routed device drawer (`devices/:deviceId`).
        record: { noun: "Device" },
      },
      {
        // I-12: every product has users (its licence owners), whatever its Identity toggle.
        page: "users",
        label: "Users",
        path: "users",
        icon: UsersRound,
        docs: "/docs/operate/console/users/",
        inNav: true,
        // `users/:subject[/:tab]`. `data` is reserved for the Cloud Sync Data tab (U-11a): the
        // record shows it only while Cloud Sync is on, and answers a deep link with Overview.
        record: {
          noun: "User",
          tabs: ["overview", "licenses", "devices", "activity", "data"],
        },
      },
      {
        // HA-06: the images Polaris Key hosts for the product (icon, listing art, store slots).
        page: "presentation",
        tile: "product",
        label: "Presentation",
        path: "settings/presentation",
        icon: Image,
        docs: "/docs/operate/console/presentation/",
        inNav: false,
      },
      {
        // A-27.11: the store listing's home (A-18j's Listing page moved here): the shared listing
        // model's text, fit report, images, release notes and Push, for every channel or one.
        page: "presentation-listing",
        accent: "distribution",
        tile: "product",
        label: "Listing",
        path: "settings/presentation/listing",
        keywords: "store listing push listing fit report screenshots",
        icon: SquarePen,
        docs: "/docs/features/ship-builds/channels/polaris-key/",
        inNav: false,
      },
      {
        // ST-14: the Customer portal area, Polaris Locker's switches and branding.
        page: "portal",
        label: "Polaris Locker",
        path: "settings/portal",
        icon: Store,
        docs: "/docs/operate/console/products/",
        inNav: false,
      },
      {
        page: "keys",
        tile: "product",
        label: "Keys and secrets",
        path: "settings/keys",
        icon: LockKeyhole,
        docs: "/docs/operate/console/keys-and-secrets/",
        inNav: false,
      },
      {
        page: "activity",
        label: "Activity",
        path: "activity",
        icon: Activity,
        docs: "/docs/operate/console/activity/",
        inNav: true,
        shortcut: "a",
      },
      {
        page: "settings",
        tile: "product",
        label: "Settings",
        path: "settings",
        icon: Settings,
        docs: "/docs/operate/console/products/",
        inNav: true,
        shortcut: "s",
      },
      {
        page: "settings-members",
        label: "Members",
        path: "settings/members",
        icon: UsersRound,
        docs: "/docs/operate/console/products/",
        inNav: false,
      },
      {
        page: "settings-all",
        label: "All settings",
        path: "settings/all",
        icon: ListTree,
        docs: "/docs/operate/console/products/",
        inNav: false,
      },
    ],
  },
  {
    key: "license",
    label: "Licensing",
    service: "license",
    accent: "license",
    glyph: KeyRound,
    docs: "/docs/features/licensing/",
    items: [
      {
        page: "licenses",
        label: "Licenses",
        path: "license/licenses",
        icon: KeyRound,
        docs: "/docs/features/licensing/manage-licenses/",
        inNav: true,
        shortcut: "l",
        record: {
          noun: "License",
          tabs: ["overview", "keys", "devices", "activity", "config"],
        },
      },
      {
        page: "tiers",
        label: "Tiers",
        path: "license/tiers",
        icon: Layers,
        docs: "/docs/features/licensing/manage-licenses/",
        inNav: true,
        record: { noun: "Tier", tabs: ["overview", "used-by"] },
      },
      {
        page: "enrollment",
        label: "Enrollment",
        path: "license/enrollment",
        icon: Fingerprint,
        docs: "/docs/features/licensing/access/",
        inNav: true,
      },
      // LX-30: licence batches (LX-28), reached from Licenses' Batch filter and a batch licence;
      // not in the sidebar.
      {
        page: "license-batches",
        label: "Batches",
        paletteLabel: "License batches",
        path: "license/batches",
        icon: Boxes,
        docs: "/docs/features/licensing/manage-licenses/",
        inNav: false,
        record: { noun: "Batch" },
      },
      // LX-06: S-19's licensing settings (`licensing.*`, the settings area `license.licensing`).
      {
        page: "license-settings",
        label: "Settings",
        paletteLabel: "Licensing",
        path: "license/settings",
        icon: SlidersHorizontal,
        docs: "/docs/features/licensing/model/",
        inNav: true,
      },
    ],
  },
  {
    key: "config",
    label: "Managed config",
    service: "config",
    accent: "config",
    glyph: SlidersHorizontal,
    docs: "/docs/features/managed-config/",
    items: [
      {
        page: "catalog",
        label: "Catalog",
        path: "config/catalog",
        icon: ListTree,
        docs: "/docs/features/managed-config/catalog/",
        inNav: true,
        shortcut: "c",
      },
      {
        page: "catalog-edit",
        label: "Edit catalog",
        path: "config/catalog/edit",
        icon: FilePen,
        docs: "/docs/features/managed-config/catalog/",
        inNav: false,
      },
      {
        page: "profiles",
        label: "Profiles",
        path: "config/profiles",
        icon: FileStack,
        docs: "/docs/features/managed-config/profiles/",
        inNav: true,
        record: {
          noun: "Profile",
          // A History tab joins these once the activity log filters by target (ADMIN.md A-2).
          tabs: ["payload", "used-by"],
        },
      },
    ],
  },
  {
    key: "release",
    label: "Release",
    service: "release",
    accent: "release",
    glyph: Package,
    docs: "/docs/features/ship-builds/releases/",
    items: [
      {
        page: "releases",
        label: "Releases",
        path: "release/releases",
        icon: Rocket,
        docs: "/docs/features/ship-builds/releases/",
        inNav: true,
        shortcut: "r",
        // The History tab joins when activity filters (A-2) can scope it to one release.
        record: {
          noun: "Release",
          tabs: ["builds", "packs", "channels", "distribution"],
        },
      },
      {
        page: "channels",
        label: "Release tracks",
        path: "release/channels",
        icon: Waypoints,
        docs: "/docs/features/ship-builds/releases/channels/",
        inNav: true,
      },
      {
        page: "deliverables",
        label: "Deliverables",
        path: "release/deliverables",
        icon: PackageOpen,
        docs: "/docs/features/ship-builds/packs/",
        inNav: true,
        record: {
          noun: "Deliverable",
          tabs: ["releases", "channels", "delivery", "files"],
        },
      },
      {
        page: "compatibility",
        label: "Compatibility",
        path: "release/compatibility",
        icon: Grid3x3,
        docs: "/docs/features/ship-builds/releases/compatibility/",
        inNav: true,
      },
      {
        page: "simulator",
        label: "Update simulator",
        path: "release/compatibility/simulator",
        icon: FlaskConical,
        docs: "/docs/features/ship-builds/releases/compatibility/",
        inNav: false,
      },
      {
        page: "content-keys",
        label: "Content keys",
        path: "release/content-keys",
        icon: KeySquare,
        docs: "/docs/features/ship-builds/packs/",
        inNav: true,
      },
    ],
  },
  {
    key: "distribution",
    label: "Distribution",
    service: "distribution",
    // Ship builds is ONE identity (B5): Release cyan chrome and the Package glyph on Rollouts,
    // Outlets, Access, Packages and Health. The sales surfaces below set `accent: "distribution"`.
    accent: "release",
    glyph: Package,
    docs: "/docs/features/ship-builds/channels/",
    items: [
      {
        // UX-31 made the matrix Rollouts' Matrix and Readiness views; the old URL (and `g m`)
        // redirects there, so it is no longer a sidebar or palette item of its own (P0-47).
        page: "matrix",
        label: "Matrix",
        path: "distribution/matrix",
        icon: LayoutGrid,
        docs: "/docs/features/ship-builds/channels/",
        inNav: false,
        shortcut: "m",
        shortcutLabel: "Rollouts (matrix)",
      },
      {
        page: "rollouts",
        label: "Rollouts",
        // The matrix and readiness are its views (UX-31), so their names find it (P0-47).
        keywords: "matrix readiness",
        path: "distribution/rollouts",
        icon: TrendingUp,
        docs: "/docs/features/ship-builds/channels/rollouts/",
        inNav: true,
      },
      {
        page: "outlets",
        label: "Channel setup",
        // The page's earlier name still finds it.
        keywords: "install sources feeds",
        path: "distribution/outlets",
        icon: Store,
        docs: "/docs/features/ship-builds/channels/feeds/",
        inNav: true,
      },
      {
        // A-18j: every storefront's tile, and "Add to storefronts" (T6, resumable from the
        // ledger) that provisions the product onto them.
        page: "storefronts",
        accent: "distribution",
        label: "Storefronts",
        // The first-party store is the Polaris Locker page here (B-215).
        keywords: "polaris locker listing badges discover",
        path: "distribution/storefronts",
        icon: Globe,
        docs: "/docs/features/ship-builds/channels/storefronts/",
        inNav: true,
        // PS-06 (SETUP.md §2.1: one page per storefront): a built-in store's own page,
        // `distribution/storefronts/polaris-key`.
        record: { noun: "Storefront" },
      },
      {
        // A-22: one page per channel, `distribution/channels/<id>/<tab>`. No sidebar item: the
        // channel list is the Outlets and Storefronts pages (A-21 owns the IA).
        page: "channel",
        accent: "distribution",
        label: "Channel",
        path: "distribution/channels",
        icon: Store,
        docs: "/docs/features/ship-builds/channels/",
        inNav: false,
        tile: "service",
        record: { noun: "Channel", tabs: CHANNEL_TAB_IDS },
      },
      {
        page: "access",
        label: "Access",
        path: "distribution/access",
        icon: ShieldCheck,
        docs: "/docs/features/ship-builds/channels/delivery/",
        inNav: true,
      },
      {
        // F-11: the product's package feeds on pkg.plrs.im. F-34.7: listed whenever Distribution
        // is on (the empty and off states live on the page); "Packages" is the mockup's name.
        page: "package-feeds",
        label: "Packages",
        keywords: "package feeds npm pypi swift maven oci godot registry",
        path: "distribution/feeds",
        icon: Archive,
        docs: "/docs/features/ship-builds/packages/",
        inNav: true,
        record: {
          noun: "Feed",
          tabs: FEED_TABS,
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
        docs: "/docs/features/ship-builds/channels/update-health/",
        inNav: true,
      },
      {
        page: "credentials",
        accent: "distribution",
        label: "Credentials",
        keywords: "channel credentials store keys connectors",
        path: "distribution/credentials",
        icon: Plug,
        docs: "/docs/features/ship-builds/channels/",
        inNav: true,
      },
    ],
  },
  {
    key: "update",
    label: "Update",
    service: "update",
    // Update is a docs and marketing identity, not a console one (B5): its page is Ship builds'.
    accent: "release",
    glyph: Package,
    docs: "/docs/features/ship-builds/updates/",
    items: [
      {
        page: "feed",
        tile: "service",
        label: "Feed",
        path: "update/feed",
        icon: Rss,
        docs: "/docs/features/ship-builds/updates/eligibility/",
        inNav: true,
      },
    ],
  },
  {
    key: "identity",
    label: "Sign-in",
    service: "identity",
    accent: "identity",
    glyph: UserRound,
    docs: "/docs/features/sign-in/",
    items: [
      {
        page: "app-sign-in",
        tile: "service",
        label: "App sign-in",
        path: "identity/app-sign-in",
        icon: LogIn,
        docs: "/docs/features/sign-in/customer-portal/",
        inNav: true,
      },
    ],
  },
  {
    key: "sync",
    label: "Cloud Sync",
    service: "sync",
    accent: "sync",
    glyph: Cloud,
    docs: "/docs/features/cloud-sync/",
    items: [
      {
        // One row for the feature: Setup is the page, Data its second route tab.
        page: "sync-setup",
        tile: "service",
        label: "Cloud Sync",
        path: "sync/setup",
        icon: Cloud,
        docs: "/docs/features/cloud-sync/",
        inNav: true,
      },
      {
        // A tab of Cloud Sync, not a sidebar item.
        page: "sync-usage",
        tile: "service",
        label: "Usage",
        path: "sync/usage",
        icon: Database,
        docs: "/docs/features/cloud-sync/",
        inNav: false,
      },
      {
        // A tab of Cloud Sync, not a sidebar item; its address is unchanged.
        page: "sync-data",
        tile: "service",
        label: "Data",
        path: "sync/data",
        icon: Database,
        docs: "/docs/features/cloud-sync/",
        inNav: false,
      },
    ],
  },
  {
    key: "commerce",
    label: "Commerce",
    service: "commerce",
    accent: "commerce",
    glyph: ShoppingBag,
    docs: "/docs/features/commerce/",
    items: [
      {
        page: "commerce-overview",
        tile: "service",
        label: "Overview",
        path: "commerce",
        icon: LayoutDashboard,
        docs: "/docs/features/commerce/",
        inNav: true,
      },
      {
        // A-17g: the commerce mappings beside the store's own products (App Store products, T2),
        // moved from Distribution by CM-29. CM-23 adds the offers, purchases and sales pages.
        page: "commerce",
        label: "In-app purchases",
        path: "commerce/in-app-purchases",
        icon: ShoppingBag,
        docs: "/docs/features/commerce/",
        inNav: true,
        // The mappings are App Store products: a product the App Store is out of scope for has none.
        requires: "channel:app-store",
      },
    ],
  },
  {
    key: "connect",
    label: "Cloud Connect",
    service: "connect",
    accent: "connect",
    glyph: Radar,
    docs: "/docs/features/cloud-connect/",
    items: [
      {
        // One row for the feature: Setup is the page, Linked devices and Usage its route tabs.
        page: "connect-setup",
        tile: "service",
        label: "Cloud Connect",
        path: "connect/setup",
        icon: Radar,
        docs: "/docs/features/cloud-connect/",
        inNav: true,
      },
      {
        // A tab of Cloud Connect, not a sidebar item.
        page: "connect-usage",
        tile: "service",
        label: "Usage",
        path: "connect/usage",
        icon: Radar,
        docs: "/docs/features/cloud-connect/",
        inNav: false,
      },
      {
        // A tab of Cloud Connect, not a sidebar item.
        page: "connect-devices",
        tile: "service",
        label: "Linked devices",
        path: "connect/devices",
        icon: Radar,
        docs: "/docs/features/cloud-connect/",
        inNav: false,
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
 * is not a page: like a product section's key, it redirects to the group's first page (Settings).
 */
const PLATFORM_PAGES: NavPage[] = [
  {
    page: "platform-settings",
    label: "Settings",
    path: "platform/settings",
    icon: ServerCog,
    docs: "/docs/operate/platform/settings/",
    inNav: true,
    group: "platform",
  },
  {
    // ST-31.11: everyone with a role, where each role came from, and the pending invites. The
    // Worker answers Superadmins and Platform admins only (area `members`).
    page: "platform-members",
    label: "Members",
    keywords: "people roles invite access admin superadmin",
    path: "platform/members",
    icon: UsersRound,
    docs: "/docs/operate/console/tour/",
    inNav: true,
    group: "platform",
  },
  {
    // CX-PSTAT: Deployment and Operations in one page (ST-09). Their 0.9 addresses are Page moved
    // rows in the route ledger.
    page: "platform-status",
    label: "Status",
    keywords: "deployment operations deploy cron queue health migrations",
    path: "platform/status",
    icon: Server,
    docs: "/docs/operate/platform/jobs/",
    inNav: true,
    group: "platform",
  },
  {
    // I-31: the platform's sign-in connections (SSO providers, the built-in providers, email and
    // Turnstile status) and their add wizard. Stores join this page with P0-28.
    page: "platform-connections",
    label: "Connections",
    keywords: "sso oidc identity provider sign-in google apple steam domain",
    path: "platform/connections",
    icon: KeyRound,
    docs: "/docs/operate/platform/sign-in-connections/",
    inNav: true,
    group: "platform",
    record: { noun: "Connection" },
  },
  {
    page: "platform-stores",
    label: "Store connections",
    path: "platform/store-connections",
    icon: PlugZap,
    docs: "/docs/operate/platform/connections/",
    inNav: true,
    group: "platform",
  },
  {
    // F-11: the platform's own package feeds (the system product's: our SDKs) and the policy.
    page: "platform-feeds",
    label: "Package feeds",
    path: "platform/feeds",
    icon: Archive,
    docs: "/docs/features/ship-builds/packages/",
    inNav: true,
    group: "platform",
    record: {
      noun: "Feed",
      tabs: FEED_TABS,
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
    // ST-51: every product's trail and the platform's, one list. The Product facet scopes it.
    page: "platform-activity",
    label: "Activity",
    keywords: "audit log history events changes who",
    path: "platform/activity",
    icon: History,
    docs: "/docs/operate/console/activity/",
    inNav: true,
    group: "platform",
    record: { noun: "Event" },
  },
];

/** The global pages: the sidebar's platform links, the new-product wizard and the Platform section. */
export const GLOBAL_PAGES: NavPage[] = [
  {
    page: "home",
    label: "Home",
    path: "",
    icon: House,
    docs: "/docs/operate/",
    inNav: true,
  },
  {
    page: "product-new",
    label: "New product",
    path: "products/new",
    icon: Plus,
    docs: "/docs/operate/console/products/",
    inNav: false,
  },
  {
    // The admin API tokens (`pkeya_…`, the machine credential `pkey bundle` presents): instance
    // wide, so a top-level link like Products at `#/tokens`, with no product segment.
    page: "api-tokens",
    label: "API tokens",
    keywords: "pkeya bearer credential ci bundle mint",
    path: "tokens",
    icon: KeySquare,
    docs: "/docs/features/licensing/offline/",
    inNav: true,
  },
  {
    // Personal tokens (`pkeyp_`): your own, and for a Superadmin everyone's (F-33). Account menu.
    page: "personal-tokens",
    label: "Personal tokens",
    keywords: "pkeyp packages read registry person revoke",
    path: "personal-tokens",
    icon: KeyRound,
    docs: "/docs/features/ship-builds/packages/",
    // ST-34.11: reached from the account menu, not the sidebar (admin-4-21; D-9).
    inNav: false,
  },
  {
    // The operator's own sign-in methods (ST-30c.4): reached from the account menu, not the sidebar.
    page: "sign-in-methods",
    label: "Sign-in methods",
    keywords: "passkey security key console sign in account",
    path: "account/sign-in-methods",
    icon: KeyRound,
    docs: "/docs/help/passkeys/",
    inNav: false,
  },
  ...PLATFORM_PAGES,
];

/** The Platform section, as the sidebar and the palette draw it. */
export const PLATFORM_GROUP = {
  key: "platform",
  label: "Platform",
  accent: "core",
  docs: "/docs/operate/platform/deploy/",
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
  return BY_ID.get(id)?.accent ?? sectionOf(id)?.accent ?? "core";
}

/**
 * The feature a section belongs to (ST-38 `FEATURES`): Release, Distribution and Update are
 * "Ship builds" (B5). `null` for Core. The masthead's crumb names the feature, not the service.
 */
export function featureOfSection(key: SectionKey): FeatureRow | null {
  if (key === "core") return null;
  return FEATURES.find((f) => f.services.includes(key)) ?? null;
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
  return features[page.requires] !== false;
}

/**
 * The pages a section lists in the sidebar and the palette: in nav and (with `features`)
 * meeting their requirement.
 */
export function navItems(
  section: NavSection,
  features: NavFeatures = null,
): NavPage[] {
  return section.items.filter((i) => i.inNav && meetsRequirement(i, features));
}

/** The global pages the sidebar lists at the top level: Home (the products live on it, ST-44). */
export function platformLinks(): NavPage[] {
  return GLOBAL_PAGES.filter((p) => p.inNav && !p.group);
}

/** The Platform section's pages the sidebar and palette list: the ones in nav. */
export function platformItems(): NavPage[] {
  return PLATFORM_GROUP.items.filter((p) => p.inNav);
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
