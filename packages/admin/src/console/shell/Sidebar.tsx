import * as React from "react";
import { Collapsible } from "radix-ui";
import {
  ChevronDown,
  PanelLeftClose,
  PanelLeftOpen,
  TriangleAlert,
} from "lucide-react";
import { cn } from "../../lib/cn.js";
import {
  navItems,
  platformItems,
  platformLinks,
  SHIP_BUILDS_KEYS,
  visibleSections,
  type NavFeatures,
  type NavGroupKey,
  type NavPage,
  type NavSection,
  type PageId,
  type SectionKey,
  type ServiceAccent,
  type ServiceState,
} from "../nav.js";
import { usePendingRecipes } from "../sections/config/model/pending.js";
import { Link } from "../router.js";
import { globalPage, productPage } from "../routes.js";
import {
  SETTINGS_HUB_PAGES,
  CONNECT_PAGES,
  SYNC_PAGES,
  type GlobalPageId,
  type ProductPageId,
} from "../nav.js";
import { Tooltip } from "../../ui/Tooltip.js";
import { PolarisMark } from "@polaris-key/brand/react";
import { ProductSwitcher, type SwitcherContext } from "./ProductSwitcher.js";

/**
 * Which sidebar sections are open (owner requirements, 2026-10-03).
 *
 * - Every section except the one holding the current page is collapsed, to save space.
 * - A collapsed section can be expanded by hand to look inside; that is a temporary peek, and
 *   entering any other section collapses it again. Nothing is persisted.
 * - The active section is always open and cannot be collapsed.
 * - `defaultOpen` starts open (a refused page passes the groups the member can use), so a member
 *   sent to a refusal sees where they can go.
 */
export function useNavCollapse(
  activeSection: NavGroupKey | null,
  defaultOpen: readonly NavGroupKey[] = [],
): {
  expanded: ReadonlySet<NavGroupKey>;
  toggle: (key: NavGroupKey) => void;
} {
  const [peek, setPeek] = React.useState<{
    section: NavGroupKey | null;
    /** `null` until a section is toggled by hand: the defaults then stand. */
    keys: ReadonlySet<NavGroupKey> | null;
  }>({ section: activeSection, keys: null });
  // A change of section drops every peek, so only the new active section stays open.
  const base = new Set<NavGroupKey>(defaultOpen);
  const expanded =
    peek.section === activeSection && peek.keys ? peek.keys : base;
  const toggle = React.useCallback(
    (key: NavGroupKey) => {
      if (key === activeSection) return;
      setPeek((prev) => {
        const keys = new Set<NavGroupKey>(
          prev.section === activeSection && prev.keys ? prev.keys : base,
        );
        if (keys.has(key)) keys.delete(key);
        else keys.add(key);
        return { section: activeSection, keys };
      });
    },
    [activeSection],
  );
  return { expanded, toggle };
}

export interface SidebarProps {
  /** The product in scope; `null` on the global pages, which show platform links only (SH-10). */
  slug: string | null;
  services: ServiceState;
  /** The product facts a `requires` reads (a store channel page needs its channel in scope). */
  features?: NavFeatures;
  activePage: PageId | null;
  /** The group holding the current page: a product section, `platform`, or none (Home). */
  activeSection: NavGroupKey | null;
  /** Sections expanded by hand besides the active one (see `useNavCollapse`). */
  expanded: ReadonlySet<NavGroupKey>;
  onToggleSection: (key: NavGroupKey) => void;
  /** Icons-only rail (desktop). */
  rail?: boolean;
  onToggleRail?: () => void;
  /** Called after a link is followed (the mobile drawer closes). */
  onNavigate?: () => void;
  /** Warm a section's code on hover or focus (React.lazy per section). */
  onPrefetch?: (key: SectionKey) => void;
  idPrefix: string;
  /** ST-29: may the member open this page? Pages it may not are left out. Default: every page. */
  canOpen?: (page: PageId) => boolean;
  /** The context header's switcher (ST-45): the product in scope, or Platform when `null`. */
  switcher?: SwitcherContext;
}

/** One sidebar group: a section, or Ship builds' three merged (B5: one identity, one group). */
interface GroupEntry {
  section: NavSection;
  /** Every section key the group holds; the active one is any of them. */
  keys: SectionKey[];
  items: NavPage[];
}

/**
 * Release, Distribution and Update are one feature, Ship builds (Home's glyph, the switcher's
 * pip): one group, headed "Ship builds" with the Package glyph once, holding all of their pages.
 * The sections stay three in the nav model (routes, docs and the services toggles read them).
 */
function shipBuildsGrouped(
  entries: { section: NavSection; items: NavPage[] }[],
): GroupEntry[] {
  const out: GroupEntry[] = [];
  for (const { section, items } of entries) {
    if (!SHIP_BUILDS_KEYS.includes(section.key)) {
      out.push({ section, keys: [section.key], items });
      continue;
    }
    const held = out.find((g) =>
      g.keys.some((k) => SHIP_BUILDS_KEYS.includes(k)),
    );
    if (held) {
      held.keys.push(section.key);
      held.items = [...held.items, ...items];
    } else
      out.push({
        section: { ...section, label: "Ship builds", accent: "release" },
        keys: [section.key],
        items: [...items],
      });
  }
  return out;
}

/**
 * The console sidebar (ADMIN.md §2.1, components.md §1.4, ST-45): two contexts, never mixed.
 *
 * A pinned context header (the switcher card) tops a scrolling list and a pinned foot.
 * - Platform context (no product in scope): Home, the Platform pages, then the instance-wide token
 *   pages. The foot holds Collapse.
 * - Product context: Core's pages as a flat list (Overview, Integration, Devices, Users,
 *   Activity), then one group per enabled feature in canonical order (a feature that is off has no
 *   group, not a greyed one). The foot holds Settings and Collapse. No platform page appears here;
 *   Platform is one step away in the switcher.
 *
 * Group headers are disclosure buttons (`aria-expanded`, `aria-controls`) with no icon; a feature
 * with one page is one row, the label being the link. Only the active group is open; `expanded`
 * names the groups peeked into by hand (see `useNavCollapse`).
 */
export function Sidebar({
  slug,
  services,
  features = null,
  activePage,
  activeSection,
  expanded,
  onToggleSection,
  rail = false,
  onToggleRail,
  onNavigate,
  onPrefetch,
  idPrefix,
  canOpen = () => true,
  switcher,
}: SidebarProps): React.ReactElement {
  const sections = slug ? visibleSections(services) : [];
  // Recipes awaiting approval ride the Catalog item, where their entries live.
  const pending = usePendingRecipes(slug ?? "").recipes.length;
  // ST-29: what the member cannot open is absent, not disabled (ADMIN.md §5.10, hidden vs
  // disabled). A group with nothing left to show goes too.
  const links = platformLinks().filter((p) => canOpen(p.page));
  const platform = platformItems().filter((p) => canOpen(p.page));
  const home = links.filter((p) => p.page === "home");
  const tokens = links.filter((p) => p.page !== "home");
  const platformList = [...home, ...platform, ...tokens];
  const swapped = useRailSwap(rail);
  const listRef = React.useRef<HTMLDivElement>(null);
  const edges = useScrollEdges(listRef);
  // The current page is kept in view: on every route change, and when the drawer mounts.
  React.useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>("[aria-current=page]")
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activePage, slug, rail]);
  const all = sections
    .map((section) => ({
      section,
      items: navItems(section, features).filter((p) => canOpen(p.page)),
    }))
    .filter(({ items }) => items.length > 0);
  const core = all.find(({ section }) => section.key === "core");
  // Settings sits in the foot, not the list.
  const coreItems = (core?.items ?? []).filter((p) => p.page !== "settings");
  const settings = (core?.items ?? []).find((p) => p.page === "settings");
  const features_ = shipBuildsGrouped(
    all.filter(({ section }) => section.key !== "core"),
  );
  const listItem = (p: NavPage, to: string): React.ReactElement => (
    <li key={p.page}>
      <SidebarItem
        page={p}
        to={to}
        active={isActivePage(activePage, p.page)}
        rail={rail}
        onNavigate={onNavigate}
      />
    </li>
  );
  return (
    <nav
      aria-label="Console"
      data-rail-swap={swapped ? "" : undefined}
      data-context={slug ? "product" : "platform"}
      className="group/nav flex min-h-0 flex-1 flex-col"
    >
      {/* Nothing to switch to (no Platform area, at most the one product): no card. */}
      {switcher &&
      (switcher.platform !== false || switcher.products.length > 1) ? (
        <div className={cn("shrink-0", rail ? "px-2 pt-3" : "px-3 pt-3")}>
          <ProductSwitcher {...switcher} rail={rail} />
        </div>
      ) : null}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {/* Scroll-edge fades, drawn only while there is more list that way. */}
        {edges.top ? (
          <div
            aria-hidden
            data-nav-fade="top"
            className="pointer-events-none absolute inset-x-0 top-0 z-10 h-6 bg-[linear-gradient(to_bottom,var(--color-surface-page),transparent)]"
          />
        ) : null}
        {edges.bottom ? (
          <div
            aria-hidden
            data-nav-fade="bottom"
            className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-6 bg-[linear-gradient(to_top,var(--color-surface-page),transparent)]"
          />
        ) : null}
        <div
          ref={listRef}
          data-nav-list=""
          className={cn(
            "flex min-h-0 flex-1 scroll-py-6 flex-col gap-1 overflow-y-auto pk-scroll",
            rail ? "px-2 py-3" : "p-3",
          )}
        >
          {slug === null ? (
            <ul className="flex flex-col gap-0.5" data-service="core">
              {platformList.map((p) =>
                listItem(p, globalPage(p.page as GlobalPageId)),
              )}
            </ul>
          ) : (
            <>
              {coreItems.length > 0 ? (
                <ul className="flex flex-col gap-0.5" data-service="core">
                  {coreItems.map((p) =>
                    listItem(p, productPage(slug, p.page as ProductPageId)),
                  )}
                </ul>
              ) : null}
              {features_.map(({ section, keys, items }) => (
                <SidebarGroup
                  key={section.key}
                  groupKey={section.key}
                  label={section.label}
                  accent={section.accent}
                  glyph={section.glyph}
                  items={items.map((p) => ({
                    page: p,
                    to: productPage(slug, p.page as ProductPageId),
                    badge: p.page === "catalog" ? pending : 0,
                  }))}
                  activePage={activePage}
                  active={keys.some((k) => k === activeSection)}
                  open={keys.some(
                    (k) => k === activeSection || expanded.has(k),
                  )}
                  onToggle={() => onToggleSection(section.key)}
                  rail={rail}
                  onNavigate={onNavigate}
                  onPrefetch={() => keys.forEach((k) => onPrefetch?.(k))}
                  contentId={`${idPrefix}-section-${section.key}`}
                />
              ))}
            </>
          )}
        </div>
      </div>
      {settings || onToggleRail ? (
        <div
          data-nav-foot=""
          data-service="core"
          className={cn(
            "flex shrink-0 flex-col gap-0.5 border-t border-border",
            rail ? "px-2 py-2" : "p-3",
          )}
        >
          {slug && settings ? (
            <ul>{listItem(settings, productPage(slug, "settings"))}</ul>
          ) : null}
          {onToggleRail ? (
            <button
              type="button"
              onClick={onToggleRail}
              aria-label={rail ? "Expand the sidebar" : "Collapse the sidebar"}
              className={cn(
                "flex min-h-10 w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-fg-muted hover:bg-hover hover:text-fg-strong",
                "focus-visible:outline-2 focus-visible:outline-focus",
                rail && "justify-center px-0",
              )}
            >
              {rail ? (
                <PanelLeftOpen aria-hidden className="size-4" />
              ) : (
                <PanelLeftClose aria-hidden className="size-4" />
              )}
              {rail ? null : <span className={RAIL_FADE}>Collapse</span>}
            </button>
          ) : null}
        </div>
      ) : null}
    </nav>
  );
}

/**
 * The rail toggle (S-23 §6.1; MO-10): the column snaps to its new width (a width animation would
 * re-lay the whole page every frame) and what the swap mounts, the labels and the section headers
 * or rules, fades in at `base`. Only once the rail has been toggled: a first render and the
 * phone drawer draw at once. Token-timed, so under reduced motion it is an instant swap.
 */
const RAIL_FADE = "group-data-[rail-swap]/nav:animate-pk-fade-in";

/** Is the list scrolled off its top, or does it run past its bottom? */
function useScrollEdges(ref: React.RefObject<HTMLElement | null>): {
  top: boolean;
  bottom: boolean;
} {
  const [edges, setEdges] = React.useState({ top: false, bottom: false });
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (): void => {
      const next = {
        top: el.scrollTop > 2,
        bottom: el.scrollTop + el.clientHeight < el.scrollHeight - 2,
      };
      setEdges((p) =>
        p.top === next.top && p.bottom === next.bottom ? p : next,
      );
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    ro?.observe(el);
    for (const c of Array.from(el.children)) ro?.observe(c);
    return () => {
      el.removeEventListener("scroll", measure);
      ro?.disconnect();
    };
  }, [ref]);
  return edges;
}

/** True once `rail` has changed since mount. */
function useRailSwap(rail: boolean): boolean {
  const initial = React.useRef(rail);
  const [swapped, setSwapped] = React.useState(false);
  if (!swapped && rail !== initial.current) setSwapped(true);
  return swapped;
}

/** A page is active itself, or as the parent of the page shown (New product → Home, its crumb). */
function isActivePage(activePage: PageId | null, page: string): boolean {
  return (
    activePage === page ||
    (activePage === "product-new" && page === "home") ||
    // A channel's page is reached from Channel setup (A-22).
    (page === "outlets" && activePage === "channel") ||
    // The settings hub's tabs are Settings (ST-08).
    (page === "settings" &&
      activePage !== null &&
      SETTINGS_HUB_PAGES.includes(activePage as ProductPageId)) ||
    // Cloud Sync's Data tab is Cloud Sync.
    (page === "sync-setup" &&
      activePage !== null &&
      SYNC_PAGES.includes(activePage as ProductPageId)) ||
    // Cloud Connect's tabs are Cloud Connect.
    (page === "connect-setup" &&
      activePage !== null &&
      CONNECT_PAGES.includes(activePage as ProductPageId))
  );
}

function SidebarGroup({
  groupKey,
  label,
  accent,
  glyph,
  items: links,
  activePage,
  active,
  open,
  onToggle,
  rail,
  onNavigate,
  onPrefetch,
  contentId,
}: {
  groupKey: NavGroupKey;
  label: string;
  accent: ServiceAccent;
  /** The section glyph, drawn for a collapsed section in the rail; Platform has none. */
  glyph?: NavSection["glyph"];
  items: { page: NavPage; to: string; badge?: number }[];
  activePage: PageId | null;
  active: boolean;
  open: boolean;
  onToggle: () => void;
  rail: boolean;
  onNavigate?: () => void;
  onPrefetch?: () => void;
  contentId: string;
}): React.ReactElement {
  const items = links.map(({ page: p, to, badge }) => (
    <li key={p.page}>
      <SidebarItem
        page={p}
        to={to}
        badge={badge}
        active={isActivePage(activePage, p.page)}
        rail={rail}
        onNavigate={onNavigate}
        onPrefetch={onPrefetch}
      />
    </li>
  ));

  if (rail) {
    // Icons only: the section reads as an accent rule between groups, named for assistive tech.
    // Only the active section shows its pages (the one-open-section rule); any other section is
    // one icon, the section glyph (its first page's icon where it has none), named for the
    // section and linking to that first page.
    const first = links[0];
    return (
      <div data-service={accent} data-section={groupKey}>
        <div
          role="separator"
          aria-label={label}
          className={cn("mx-2 my-2 h-0.5 rounded-full bg-accent", RAIL_FADE)}
        />
        <ul className="flex flex-col gap-0.5">
          {active || !first ? (
            items
          ) : (
            <li>
              <SidebarItem
                page={{
                  ...first.page,
                  label,
                  icon: glyph && glyph !== "star-cut" ? glyph : first.page.icon,
                }}
                starCut={glyph === "star-cut"}
                to={first.to}
                active={false}
                rail
                onNavigate={onNavigate}
                onPrefetch={onPrefetch}
              />
            </li>
          )}
        </ul>
      </div>
    );
  }

  // A feature with exactly one page is one row: the label is the link, no chevron (B5).
  if (links.length === 1) {
    const only = links[0]!;
    const current = isActivePage(activePage, only.page.page);
    return (
      <div data-service={accent} data-section={groupKey} className="pt-1.5">
        <Link
          to={only.to}
          aria-current={current ? "page" : undefined}
          data-page={only.page.page}
          data-section-header={groupKey}
          data-forced-flat=""
          onClick={() => onNavigate?.()}
          onMouseEnter={onPrefetch}
          onFocus={onPrefetch}
          className={cn(
            "relative flex min-h-10 w-full items-center gap-2 overflow-hidden rounded-md py-1 ps-2 pe-2 text-sm font-medium text-fg-strong",
            "hover:bg-accent-subtle focus-visible:outline-2 focus-visible:outline-accent-fg",
            // The selected row: fill and the 3 px inset marker, never the fill alone.
            current &&
              "bg-accent-subtle before:absolute before:inset-y-0 before:start-0 before:w-[3px] before:bg-accent forced-colors:before:bg-[Highlight]",
          )}
        >
          <span
            aria-hidden
            className="h-3.5 w-[3px] shrink-0 rounded-full bg-accent"
          />
          <span className="truncate">{label}</span>
        </Link>
      </div>
    );
  }

  return (
    <Collapsible.Root
      open={open}
      onOpenChange={() => onToggle()}
      data-service={accent}
      data-section={groupKey}
      className="pt-1.5"
    >
      <Collapsible.Trigger asChild>
        <button
          type="button"
          id={`${contentId}-header`}
          aria-controls={contentId}
          aria-disabled={active || undefined}
          data-section-header={groupKey}
          data-forced-flat=""
          title={active ? "Contains the current page" : undefined}
          className={cn(
            "group flex min-h-10 w-full items-center gap-2 rounded-md py-1 ps-2 pe-2 text-start text-sm font-medium",
            // Forced colours draw a button as a bordered box; the header is a row, not a control box
            // (data-forced-flat opts it out of the unlayered border rule in styles.css).
            "text-fg-strong hover:bg-accent-subtle focus-visible:outline-2 focus-visible:outline-accent-fg",
            active && "cursor-default hover:bg-transparent",
          )}
        >
          {/* The accent cue: visible whether the section is open or collapsed. */}
          <span
            aria-hidden
            className="h-3.5 w-[3px] shrink-0 rounded-full bg-accent"
          />
          <span className={cn("flex-1 truncate", RAIL_FADE)}>{label}</span>
          {/* The disclosure indicator, not a section icon: headers carry none (owner, 2026-10-03). */}
          <ChevronDown
            aria-hidden
            data-disclosure=""
            className={cn(
              "size-3.5 shrink-0 text-fg-muted transition-transform duration-(--pk-duration-base) ease-(--pk-ease-standard) motion-reduce:transition-none",
              !open && "-rotate-90",
              active && "opacity-40",
            )}
          />
        </button>
      </Collapsible.Trigger>
      <Collapsible.Content
        id={contentId}
        className="overflow-hidden data-[state=closed]:animate-pk-collapse-up data-[state=open]:animate-pk-collapse-down motion-reduce:animate-none"
      >
        <ul
          aria-labelledby={`${contentId}-header`}
          className="flex flex-col gap-0.5 pt-1"
        >
          {items}
        </ul>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

export function SidebarItem({
  page,
  to,
  active,
  rail,
  badge,
  starCut = false,
  onNavigate,
  onPrefetch,
}: {
  page: NavPage;
  to: string;
  active: boolean;
  rail: boolean;
  /** A count of things needing attention on this page: a warning mark and the number. */
  badge?: number;
  /** Draw the Star Cut (the Distribution glyph) in place of the page icon. */
  starCut?: boolean;
  onNavigate?: () => void;
  onPrefetch?: () => void;
}): React.ReactElement {
  const Icon = page.icon;
  const railLabel = badge
    ? `${page.label}, ${badge} ${badge === 1 ? "recipe needs" : "recipes need"} approval`
    : page.label;
  const link = (
    <Link
      to={to}
      aria-current={active ? "page" : undefined}
      aria-label={rail ? railLabel : undefined}
      data-page={page.page}
      // A mixed list (B5, B17): Storefronts in Ship builds' group is Distribution green.
      data-service={page.accent}
      onClick={() => onNavigate?.()}
      onMouseEnter={onPrefetch}
      onFocus={onPrefetch}
      className={cn(
        "relative flex min-h-10 items-center gap-2 overflow-hidden rounded-md px-3 py-2 text-sm transition-colors",
        "focus-visible:outline-2 focus-visible:outline-accent-fg",
        rail && "justify-center px-0",
        // The selected row: a subtle accent fill and a 3 px inset marker, never a solid pill.
        active
          ? "bg-accent-subtle font-medium text-fg-strong before:absolute before:inset-y-0 before:start-0 before:w-[3px] before:bg-accent forced-colors:before:bg-[Highlight]"
          : "text-fg-muted hover:bg-accent-subtle hover:text-fg-strong",
      )}
    >
      {starCut ? (
        <span aria-hidden data-nav-icon="" className="inline-flex shrink-0">
          <PolarisMark kind="update" size={16} theme="mono" />
        </span>
      ) : (
        <Icon
          aria-hidden
          data-nav-icon=""
          strokeWidth={2}
          className={cn("size-4 shrink-0", active && "text-accent")}
        />
      )}
      {rail && badge ? (
        <span
          aria-hidden
          data-nav-dot=""
          className="absolute end-2 top-1.5 size-2 rounded-full bg-warning"
        />
      ) : null}
      {rail ? null : (
        <span className={cn("truncate", RAIL_FADE)}>{page.label}</span>
      )}
      {badge && !rail ? (
        <span className="ms-auto inline-flex items-center gap-1 text-xs text-warning">
          <TriangleAlert aria-hidden className="size-3.5" />
          {badge}
          <span className="sr-only">
            {badge === 1 ? " recipe needs approval" : " recipes need approval"}
          </span>
        </span>
      ) : null}
    </Link>
  );
  return rail ? (
    <Tooltip content={railLabel} side="right">
      {link}
    </Tooltip>
  ) : (
    link
  );
}
