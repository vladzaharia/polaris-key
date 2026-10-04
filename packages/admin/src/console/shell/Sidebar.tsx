import * as React from "react";
import { Collapsible } from "radix-ui";
import { ChevronDown, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { cn } from "../../lib/cn.js";
import {
  navItems,
  platformItems,
  platformLinks,
  PLATFORM_GROUP,
  visibleSections,
  type NavFeatures,
  type NavGroupKey,
  type NavPage,
  type PageId,
  type SectionKey,
  type ServiceAccent,
  type ServiceState,
} from "../nav.js";
import { Link } from "../router.js";
import { globalPage, productPage } from "../routes.js";
import type { GlobalPageId, ProductPageId } from "../nav.js";
import { Tooltip } from "../../components/ui/index.js";

/**
 * Which sidebar sections are open (owner requirements, 2026-10-03).
 *
 * - Every section except the one holding the current page is collapsed, to save space.
 * - A collapsed section can be expanded by hand to look inside; that is a temporary peek, and
 *   entering any other section collapses it again. Nothing is persisted.
 * - The active section is always open and cannot be collapsed.
 */
export function useNavCollapse(activeSection: NavGroupKey | null): {
  expanded: ReadonlySet<NavGroupKey>;
  toggle: (key: NavGroupKey) => void;
} {
  const [peek, setPeek] = React.useState<{
    section: NavGroupKey | null;
    keys: ReadonlySet<NavGroupKey>;
  }>({ section: activeSection, keys: new Set() });
  // A change of section drops every peek, so only the new active section stays open.
  const expanded =
    peek.section === activeSection ? peek.keys : new Set<NavGroupKey>();
  const toggle = React.useCallback(
    (key: NavGroupKey) => {
      if (key === activeSection) return;
      setPeek((prev) => {
        const keys = new Set<NavGroupKey>(
          prev.section === activeSection ? prev.keys : [],
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
  /** The product facts a `requires` reads (Package feeds needs `packageFeeds`). */
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
}

/**
 * The console sidebar (ADMIN.md §2.1, components.md §1.4).
 *
 * Platform links (Home, Products) always come first, then the Platform section (instance-wide
 * pages, notes/S-13 §9.1), shown whether or not a product is in scope. With a product in scope,
 * one group per section follows, Core first and then each enabled service in canonical order (a
 * disabled service's group is absent, not greyed out: a dimmed row invites a click that can only
 * fail).
 *
 * Section headers are disclosure buttons (`aria-expanded`, `aria-controls`; Enter and Space
 * toggle) with no icon (owner, 2026-10-03); every item has one. Only the active section is open;
 * `expanded` names the sections peeked into by hand (see `useNavCollapse`). A collapsed header
 * keeps its section's accent cue: the accent rule at its start.
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
}: SidebarProps): React.ReactElement {
  const sections = slug ? visibleSections(services) : [];
  return (
    <nav
      aria-label="Console"
      className={cn(
        "flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pk-scroll",
        rail ? "px-2 py-3" : "p-3",
      )}
    >
      <ul className="flex flex-col gap-0.5" data-service="core">
        {platformLinks().map((p) => (
          <li key={p.page}>
            <SidebarItem
              page={p}
              to={globalPage(p.page as GlobalPageId)}
              active={isActivePage(activePage, p.page)}
              rail={rail}
              onNavigate={onNavigate}
            />
          </li>
        ))}
      </ul>
      {platformItems().length > 0 ? (
        <SidebarGroup
          groupKey={PLATFORM_GROUP.key}
          label={PLATFORM_GROUP.label}
          accent={PLATFORM_GROUP.accent}
          items={platformItems().map((p) => ({
            page: p,
            to: globalPage(p.page as GlobalPageId),
          }))}
          activePage={activePage}
          active={activeSection === PLATFORM_GROUP.key}
          open={
            activeSection === PLATFORM_GROUP.key ||
            expanded.has(PLATFORM_GROUP.key)
          }
          onToggle={() => onToggleSection(PLATFORM_GROUP.key)}
          rail={rail}
          onNavigate={onNavigate}
          contentId={`${idPrefix}-section-${PLATFORM_GROUP.key}`}
        />
      ) : null}
      {sections.map((section) => (
        <SidebarGroup
          key={section.key}
          groupKey={section.key}
          label={section.label}
          accent={section.accent}
          items={navItems(section, features).map((p) => ({
            page: p,
            to: productPage(slug!, p.page as ProductPageId),
          }))}
          activePage={activePage}
          active={section.key === activeSection}
          open={section.key === activeSection || expanded.has(section.key)}
          onToggle={() => onToggleSection(section.key)}
          rail={rail}
          onNavigate={onNavigate}
          onPrefetch={() => onPrefetch?.(section.key)}
          contentId={`${idPrefix}-section-${section.key}`}
        />
      ))}
      {onToggleRail ? (
        <div className="mt-auto pt-2">
          <button
            type="button"
            onClick={onToggleRail}
            aria-label={rail ? "Expand the sidebar" : "Collapse the sidebar"}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm text-fg-muted hover:bg-hover hover:text-fg-strong",
              "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus",
              rail && "justify-center px-0",
            )}
          >
            {rail ? (
              <PanelLeftOpen aria-hidden className="size-4" />
            ) : (
              <PanelLeftClose aria-hidden className="size-4" />
            )}
            {rail ? null : <span>Collapse</span>}
          </button>
        </div>
      ) : null}
    </nav>
  );
}

/** A page is active itself, or as the parent of the page shown (New product → Products). */
function isActivePage(activePage: PageId | null, page: string): boolean {
  return (
    activePage === page || (activePage === "product-new" && page === "products")
  );
}

function SidebarGroup({
  groupKey,
  label,
  accent,
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
  items: { page: NavPage; to: string }[];
  activePage: PageId | null;
  active: boolean;
  open: boolean;
  onToggle: () => void;
  rail: boolean;
  onNavigate?: () => void;
  onPrefetch?: () => void;
  contentId: string;
}): React.ReactElement {
  const items = links.map(({ page: p, to }) => (
    <li key={p.page}>
      <SidebarItem
        page={p}
        to={to}
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
    // one icon, its first page, named for the section.
    const first = links[0];
    return (
      <div data-service={accent} data-section={groupKey}>
        <div
          role="separator"
          aria-label={label}
          className="mx-2 my-2 h-0.5 rounded-full bg-accent"
        />
        <ul className="flex flex-col gap-0.5">
          {active || !first ? (
            items
          ) : (
            <li>
              <SidebarItem
                page={{ ...first.page, label }}
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

  return (
    <Collapsible.Root
      open={open}
      onOpenChange={() => onToggle()}
      data-service={accent}
      data-section={groupKey}
      className="pt-3"
    >
      <Collapsible.Trigger asChild>
        <button
          type="button"
          aria-controls={contentId}
          aria-disabled={active || undefined}
          data-section-header={groupKey}
          title={active ? "Contains the current page" : undefined}
          className={cn(
            "group flex w-full items-center gap-2 rounded-md py-1 pl-2 pr-2 text-left text-xs font-bold uppercase tracking-wider",
            "text-accent-fg hover:bg-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus",
            active && "cursor-default hover:bg-transparent",
          )}
        >
          {/* The accent cue: visible whether the section is open or collapsed. */}
          <span
            aria-hidden
            className="h-3.5 w-0.5 shrink-0 rounded-full bg-accent"
          />
          <span className="flex-1 truncate">{label}</span>
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
        <ul className="flex flex-col gap-0.5 pt-1">{items}</ul>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

export function SidebarItem({
  page,
  to,
  active,
  rail,
  onNavigate,
  onPrefetch,
}: {
  page: NavPage;
  to: string;
  active: boolean;
  rail: boolean;
  onNavigate?: () => void;
  onPrefetch?: () => void;
}): React.ReactElement {
  const Icon = page.icon;
  const link = (
    <Link
      to={to}
      aria-current={active ? "page" : undefined}
      aria-label={rail ? page.label : undefined}
      data-page={page.page}
      onClick={() => onNavigate?.()}
      onMouseEnter={onPrefetch}
      onFocus={onPrefetch}
      className={cn(
        "relative flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
        "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus",
        rail && "justify-center px-0",
        active
          ? "bg-accent-subtle font-bold text-fg-strong before:absolute before:inset-y-1 before:left-0 before:w-[3px] before:rounded-full before:bg-accent"
          : "text-fg-muted hover:bg-hover hover:text-fg-strong",
      )}
    >
      <Icon
        aria-hidden
        data-nav-icon=""
        strokeWidth={2}
        className={cn("size-4 shrink-0", active && "text-accent")}
      />
      {rail ? null : <span className="truncate">{page.label}</span>}
    </Link>
  );
  return rail ? (
    <Tooltip content={page.label} side="right">
      {link}
    </Tooltip>
  ) : (
    link
  );
}
