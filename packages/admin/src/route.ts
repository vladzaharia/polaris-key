/**
 * Hash routing without a router dependency, plus the suite console's NAV MODEL (spec §8, D-15).
 *
 * Hash routing keeps deep links + back/forward working and lets the static SPA be served under
 * `/manage/` with no server rewrites.
 *
 *   #/                                  -> dashboard
 *   #/products                          -> platform product registry
 *   #/p/<slug>/overview                 -> product operational overview
 *   #/p/<slug>/licenses                 -> licenses list for a product
 *   #/p/<slug>/licenses/<id>            -> a license detail
 *   #/p/<slug>/profiles/<id>            -> a profile detail (the managed-payload editor)
 *   #/p/<slug>/<tab>                    -> any other per-product view
 *
 * Every per-product view carries the slug as the first path segment so deep links + the
 * product switcher stay in sync.
 *
 * ── WHY THE NAV MODEL LIVES HERE AND NOT IN THE SHELL ───────────────────────────────────────
 *
 * A tab is now a member of a SERVICE SECTION, and a section is only shown when the product runs
 * that service (D-15). Three different places need that answer — the sidebar (which sections to
 * draw), the router (whether a deep link points at a section this product does not run), and the
 * topbar (which accent + title to show) — so it is data, declared once, rather than three
 * conditionals that can disagree.
 *
 * The platform section is deliberately NOT a service: product registry, service enablement,
 * secrets, activity and settings exist for every product, including one running no services at
 * all. It carries the `core` accent (D-17) and is never filtered out.
 */

import type { ServiceSlug } from "./api.js";

export type Tab =
  // platform / core
  | "overview"
  | "services"
  | "secrets"
  | "activity"
  | "settings"
  // license
  | "licenses"
  | "tiers"
  | "fingerprints"
  // config
  | "config"
  | "profiles"
  // release
  | "releases"
  // update
  | "updates"
  // identity
  | "identity";

/**
 * The full set of per-product views: every nav tab plus the two DETAIL LEAVES. A leaf is not a
 * tab — nothing in the sidebar points at one — but it is a first-class route so an operator can
 * link to "the license/profile that is misconfigured" and so back/forward work through an edit.
 */
export type View = Tab | "license" | "profile";

/**
 * A section's `data-service` token (D-17). License brands as `key` and Identity as `id` per the
 * brand registry; Config/Release/Update take their own slug; the platform substrate is `core`.
 */
export type ServiceAccent =
  | "core"
  | "key"
  | "config"
  | "release"
  | "update"
  | "id";

export interface NavItem {
  tab: Tab;
  label: string;
}

export interface NavSection {
  /** Stable key — also the React key and the test hook. */
  key: "platform" | ServiceSlug;
  label: string;
  /** The `data-service` attribute value carried by the section container + sidebar group. */
  accent: ServiceAccent;
  /**
   * The service that must be enabled for this section to exist. `null` = the platform section,
   * which is always shown: an operator has to be able to reach service enablement even when
   * every service is off.
   */
  service: ServiceSlug | null;
  items: NavItem[];
}

export const SECTIONS: NavSection[] = [
  {
    key: "platform",
    label: "Platform",
    accent: "core",
    service: null,
    items: [
      { tab: "overview", label: "Overview" },
      { tab: "services", label: "Services" },
      { tab: "secrets", label: "Secrets" },
      { tab: "activity", label: "Activity" },
      { tab: "settings", label: "Settings" },
    ],
  },
  {
    key: "license",
    label: "License",
    accent: "key",
    service: "license",
    items: [
      { tab: "licenses", label: "Licenses" },
      { tab: "tiers", label: "Tiers" },
      { tab: "fingerprints", label: "Enrollment & fingerprints" },
    ],
  },
  {
    key: "config",
    label: "Config",
    accent: "config",
    service: "config",
    items: [
      { tab: "config", label: "Catalog" },
      { tab: "profiles", label: "Profiles" },
    ],
  },
  {
    key: "release",
    label: "Release",
    accent: "release",
    service: "release",
    items: [{ tab: "releases", label: "Releases" }],
  },
  {
    key: "update",
    label: "Update",
    accent: "update",
    service: "update",
    items: [{ tab: "updates", label: "Update settings" }],
  },
  {
    key: "identity",
    label: "Identity",
    accent: "id",
    service: "identity",
    items: [{ tab: "identity", label: "Sign-in & portal" }],
  },
];

/** Every tab, flattened in nav order. */
export const TABS: NavItem[] = SECTIONS.flatMap((s) => s.items);

const KNOWN_TABS: Tab[] = TABS.map((t) => t.tab);

/** The section a tab belongs to. Total by construction — every tab is declared in `SECTIONS`. */
export function sectionOf(tab: Tab): NavSection {
  const found = SECTIONS.find((s) => s.items.some((i) => i.tab === tab));
  // `Tab` is derived from SECTIONS by hand, so this is unreachable; the fallback keeps the
  // signature total rather than making every caller handle a null the type forbids.
  return found ?? SECTIONS[0]!;
}

/** What a product runs. `null`/absent means "not loaded yet" — see `isSectionEnabled`. */
export type ServiceState = Record<ServiceSlug, { enabled: boolean }> | null;

/**
 * Is this section shown for a product with this enablement set?
 *
 * The platform section is always shown. While enablement is still loading (`null`) every
 * section is shown: hiding first and revealing later makes the nav jump under the operator's
 * cursor, and the section a deep link points at would flash a "not enabled" screen before the
 * answer arrived. Enablement is an affordance filter here, not an access control — the worker
 * gates every one of these endpoints itself.
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

/** Is the view behind a service this product does not run? (Drives the not-enabled screen.) */
export function isTabEnabled(tab: Tab, services: ServiceState): boolean {
  return isSectionEnabled(sectionOf(tab), services);
}

export function normalizeView(view: View): Tab | "license" | "profile" {
  if (view === "license" || view === "profile") return view;
  return view;
}

export type Route =
  | { kind: "dashboard" }
  | { kind: "products" }
  | { kind: "product"; slug: string; view: Tab }
  | { kind: "product"; slug: string; view: "license"; id: string }
  | { kind: "product"; slug: string; view: "profile"; id: string };

/** The list view a detail leaf hangs off, and the URL segment it is nested under. */
const LEAF_PARENT: Record<"license" | "profile", Tab> = {
  license: "licenses",
  profile: "profiles",
};

const PRODUCT = /^#\/p\/([^/]+)(?:\/([^/]+))?(?:\/([^/?]+))?/;

export function parseRoute(hash: string): Route {
  if (hash === "" || hash === "#" || hash === "#/")
    return { kind: "dashboard" };
  if (hash.startsWith("#/products")) return { kind: "products" };
  const m = hash.match(PRODUCT);
  if (m && m[1]) {
    const slug = decodeURIComponent(m[1]);
    const view = (m[2] as View | undefined) ?? "overview";
    if (view === "licenses" && m[3]) {
      return {
        kind: "product",
        slug,
        view: "license",
        id: decodeURIComponent(m[3]),
      };
    }
    if (view === "profiles" && m[3]) {
      return {
        kind: "product",
        slug,
        view: "profile",
        id: decodeURIComponent(m[3]),
      };
    }
    // An unrecognised segment lands on the overview, not on Licenses: with the nav filtered by
    // enablement, Licenses is a view a config-only product does not have, so it cannot be the
    // fallback for "I don't know what you meant". Overview is in the platform section, which
    // every product has.
    const tab = (KNOWN_TABS as string[]).includes(view)
      ? (view as Tab)
      : "overview";
    return { kind: "product", slug, view: tab };
  }
  return { kind: "dashboard" };
}

/** The active sidebar tab for a route (a detail leaf maps back to its list). */
export function tabOf(route: Route): Tab | null {
  if (route.kind !== "product") return null;
  const view = normalizeView(route.view);
  if (view === "license" || view === "profile") return LEAF_PARENT[view];
  return view;
}

export function hashFor(route: Route): string {
  if (route.kind === "dashboard") return "#/";
  if (route.kind === "products") return "#/products";
  if (route.view === "license" || route.view === "profile") {
    const parent = LEAF_PARENT[route.view];
    return `#/p/${encodeURIComponent(route.slug)}/${parent}/${encodeURIComponent(route.id)}`;
  }
  return `#/p/${encodeURIComponent(route.slug)}/${route.view}`;
}

export function navigate(route: Route): void {
  window.location.hash = hashFor(route);
}
