import * as React from "react";
import {
  Activity,
  Blocks,
  Boxes,
  ClipboardList,
  FileStack,
  Fingerprint,
  KeyRound,
  Layers,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  RefreshCw,
  Rocket,
  Settings,
  SlidersHorizontal,
  Sun,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { cn } from "../lib/cn.js";
import type { Me } from "../api.js";
import {
  sectionOf,
  tabOf,
  visibleSections,
  type Route,
  type ServiceState,
  type Tab,
} from "../route.js";
import { Logo, LogoMark } from "./brand/Logo.js";
import { useTheme } from "./theme.js";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  TooltipProvider,
} from "./ui/index.js";

/**
 * One icon per tab. Grouped by section to match `SECTIONS`, so a tab added to the nav model
 * without an icon here is visible as a gap in this list rather than only at runtime.
 * `Fingerprint` moved off Identity onto the License section's enrollment view — the actual
 * hardware-binding surface — leaving Identity with the person glyph its OIDC/portal settings
 * are really about.
 */
const TAB_ICONS: Partial<Record<Tab, LucideIcon>> = {
  // platform / core
  overview: LayoutDashboard,
  services: Blocks,
  secrets: ClipboardList,
  activity: Activity,
  settings: Settings,
  // license
  licenses: KeyRound,
  tiers: Layers,
  fingerprints: Fingerprint,
  // config
  config: SlidersHorizontal,
  profiles: FileStack,
  // release
  releases: Rocket,
  // update
  updates: RefreshCw,
  // identity
  identity: UserRound,
};

export interface ShellProps {
  me: Me;
  route: Route;
  activeSlug: string;
  /** What the active product runs — `null` while unknown, which shows every section (D-15). */
  services: ServiceState;
  onNavigate: (route: Route) => void;
  onSignOut: () => void;
  children: React.ReactNode;
}

/**
 * The app frame: a fixed sidebar (brand, product switcher, per-product nav grouped by service)
 * on desktop that collapses behind a hamburger sheet on small screens, plus a topbar carrying
 * the section title, theme toggle, and user menu. Purely presentational — routing decisions
 * come in via `route`/`onNavigate` and enablement via `services`.
 */
export function Shell({
  me,
  route,
  activeSlug,
  services,
  onNavigate,
  onSignOut,
  children,
}: ShellProps): React.ReactElement {
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const activeTab = tabOf(route);
  // Dashboard and the product registry belong to no service, so they take the platform accent
  // rather than keeping whichever section the operator came from (D-17).
  const accent = activeTab ? sectionOf(activeTab).accent : "core";

  const go = (next: Route): void => {
    setMobileOpen(false);
    onNavigate(next);
  };

  return (
    <TooltipProvider delayDuration={300}>
      <div className="min-h-screen bg-background text-foreground lg:grid lg:grid-cols-[16rem_1fr]">
        {/* Backdrop for the mobile sidebar. */}
        {mobileOpen ? (
          <button
            aria-label="Close navigation"
            className="fixed inset-0 z-30 bg-black/50 backdrop-blur-sm lg:hidden"
            onClick={() => setMobileOpen(false)}
          />
        ) : null}

        <Sidebar
          me={me}
          route={route}
          activeSlug={activeSlug}
          activeTab={activeTab}
          services={services}
          mobileOpen={mobileOpen}
          go={go}
        />

        <div className="flex min-w-0 flex-col">
          <Topbar
            route={route}
            activeTab={activeTab}
            onMenu={() => setMobileOpen(true)}
            me={me}
            onSignOut={onSignOut}
          />
          {/* The accent rides the content wrapper, not <main>, so the view's own accented
              children inherit it while the scroll container keeps neutral chrome. */}
          <main className="pk-scroll flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8">
            <div data-service={accent} className="mx-auto w-full max-w-6xl">
              {children}
            </div>
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
}

function Sidebar({
  me,
  route,
  activeSlug,
  activeTab,
  services,
  mobileOpen,
  go,
}: {
  me: Me;
  route: Route;
  activeSlug: string;
  activeTab: Tab | null;
  services: ServiceState;
  mobileOpen: boolean;
  go: (route: Route) => void;
}): React.ReactElement {
  return (
    <aside
      className={cn(
        "fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-transform",
        "lg:static lg:translate-x-0",
        mobileOpen ? "translate-x-0" : "-translate-x-full",
      )}
    >
      <div className="flex h-14 items-center border-b border-sidebar-border px-4">
        <button
          className="flex items-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => go({ kind: "dashboard" })}
          aria-label="Polaris Key dashboard"
        >
          <Logo subtitle="admin" />
        </button>
      </div>

      <nav
        className="flex flex-1 flex-col gap-1 overflow-y-auto p-3"
        aria-label="Primary"
      >
        <NavItem
          icon={LayoutDashboard}
          label="Dashboard"
          active={route.kind === "dashboard"}
          onClick={() => go({ kind: "dashboard" })}
        />
        {/* Ungated: `me.platformAdmin` is true for every session that can reach this Shell
            (admin/auth.ts gates login on the same predicate admin/authz.ts gates products on),
            so the conditional only ever pretended there was a tier that sees less. */}
        <NavItem
          icon={Boxes}
          label="Products"
          active={route.kind === "products"}
          onClick={() => go({ kind: "products" })}
        />

        <div className="my-2 px-1">
          <p className="px-2 pb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Product
          </p>
          <Select
            value={activeSlug}
            onValueChange={(slug) =>
              go({ kind: "product", slug, view: "overview" })
            }
          >
            <SelectTrigger aria-label="Product" className="bg-sidebar-accent">
              <SelectValue placeholder="Select a product" />
            </SelectTrigger>
            <SelectContent>
              {me.products.map((prod) => (
                <SelectItem key={prod.slug} value={prod.slug}>
                  {prod.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* One group per enabled service (D-15). A disabled service's group is absent, not
            greyed out: a dimmed row invites a click that can only ever fail, and the operator
            already has one honest place to turn it on — Platform → Services. */}
        {activeSlug
          ? visibleSections(services).map((section) => (
              <div
                key={section.key}
                data-service={section.accent}
                className="flex flex-col gap-0.5 pt-2 first:pt-0"
              >
                <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wider text-primary">
                  {section.label}
                </p>
                {section.items.map(({ tab, label }) => (
                  <NavItem
                    key={tab}
                    icon={TAB_ICONS[tab]}
                    label={label}
                    active={route.kind === "product" && activeTab === tab}
                    onClick={() =>
                      go({ kind: "product", slug: activeSlug, view: tab })
                    }
                  />
                ))}
              </div>
            ))
          : null}
      </nav>
    </aside>
  );
}

function NavItem({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon?: LucideIcon;
  label: string;
  active: boolean;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        // The label stays `text-foreground` and only the icon takes the accent: the accent has
        // to clear 3:1 on `sidebar-accent` (UI chrome), which is a bar every service token
        // meets, whereas holding 4.5:1 for the label there would force all six darker than the
        // indigo the console ships with today.
        active
          ? "bg-sidebar-accent text-foreground [&>svg]:text-primary"
          : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-foreground",
      )}
    >
      {Icon ? (
        <Icon className="size-4 shrink-0" />
      ) : (
        <span className="size-4 shrink-0" aria-hidden />
      )}
      <span className="truncate">{label}</span>
    </button>
  );
}

/**
 * The topbar heading. Product views are qualified by their section ("License · Licenses")
 * because the tab labels alone are ambiguous once every service owns one — "Settings" is the
 * platform tab, "Update settings" is the Update service's, and both read as "settings" at a
 * glance. Dashboard, the product registry, and a license detail belong to no section and keep
 * the bare titles they have always had.
 */
function titleFor(route: Route, activeTab: Tab | null): string {
  if (route.kind === "dashboard") return "Dashboard";
  if (route.kind === "products") return "Products";
  if (route.view === "license") return "License";
  if (!activeTab) return "Console";
  const section = sectionOf(activeTab);
  const item = section.items.find((i) => i.tab === activeTab);
  return `${section.label} · ${item?.label ?? activeTab}`;
}

function Topbar({
  route,
  activeTab,
  onMenu,
  me,
  onSignOut,
}: {
  route: Route;
  activeTab: Tab | null;
  onMenu: () => void;
  me: Me;
  onSignOut: () => void;
}): React.ReactElement {
  const title = titleFor(route, activeTab);

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-background/80 px-4 backdrop-blur sm:px-6">
      <Button
        variant="ghost"
        size="icon"
        className="lg:hidden"
        onClick={onMenu}
        aria-label="Open navigation"
      >
        <Menu />
      </Button>
      <LogoMark className="size-5 lg:hidden" />
      <h1 className="text-sm font-semibold tracking-tight">{title}</h1>
      <div className="ml-auto flex items-center gap-1.5">
        <ThemeToggle />
        <UserMenu me={me} onSignOut={onSignOut} />
      </div>
    </header>
  );
}

function ThemeToggle(): React.ReactElement {
  const { theme, toggle } = useTheme();
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggle}
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
    >
      {theme === "dark" ? <Sun /> : <Moon />}
    </Button>
  );
}

function UserMenu({
  me,
  onSignOut,
}: {
  me: Me;
  onSignOut: () => void;
}): React.ReactElement {
  const initials = me.name
    .split(/\s+/)
    .map((s) => s[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Account menu">
          <span className="flex size-7 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
            {initials || "PK"}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuLabel>
          <div className="flex flex-col">
            <span className="text-sm font-medium text-foreground">
              {me.name}
            </span>
            <span className="truncate text-xs font-normal text-muted-foreground">
              {me.email}
            </span>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem destructive onSelect={onSignOut}>
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
