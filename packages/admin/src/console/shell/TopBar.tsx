import * as React from "react";
import { BookOpen, Menu, Search } from "lucide-react";
import type { Me, PlatformIdentity } from "../../api.js";
import { Button } from "../../components/ui/index.js";
import { cn } from "../../lib/cn.js";
import type { ProductPageId, ServiceAccent } from "../nav.js";
import { BrandBlock } from "./BrandBlock.js";
import { EnvironmentBadge } from "./EnvironmentBadge.js";
import { ProductSwitcher } from "./ProductSwitcher.js";
import { ThemeMenu } from "./ThemeMenu.js";
import { UserMenu } from "./UserMenu.js";
import { Kbd, type ProductLike } from "./bits.js";

/**
 * The top bar (ADMIN.md §2.1–2.2, components.md §1.2): the global tier of navigation. Brand block
 * (Home, with the section bit), the product switcher when a product is in scope, the environment
 * badge, the palette trigger, Docs, the theme menu and the account menu. There is no page title
 * here any more: each page owns its one `<h1>` (SH-12).
 *
 * Height 64 px (BRAND.md §7.6: the 48 px mark with 8 px of clear space), plus the top safe area.
 */
export function TopBar({
  me,
  section,
  product,
  products,
  page,
  switcherOpen,
  onSwitcherOpenChange,
  docsHref,
  onOpenPalette,
  onOpenNav,
  onShortcuts,
  onSignOut,
  version,
  className,
}: {
  me: Me;
  section: ServiceAccent;
  product: ProductLike | null;
  products: ProductLike[];
  page: ProductPageId | null;
  switcherOpen: boolean;
  onSwitcherOpenChange: (open: boolean) => void;
  docsHref: string;
  onOpenPalette: () => void;
  onOpenNav: () => void;
  onShortcuts: () => void;
  onSignOut: () => void;
  /** The running build, for the account menu's version chip (A-11); absent until known. */
  version?: PlatformIdentity | null;
  className?: string;
}): React.ReactElement {
  return (
    <header
      data-shell="topbar"
      className={cn(
        "z-30 flex items-center gap-1.5 border-b border-border bg-surface-raised px-2 sm:gap-3 sm:px-4",
        "h-[calc(4rem+env(safe-area-inset-top,0px))] pt-[env(safe-area-inset-top,0px)]",
        className,
      )}
    >
      <Button
        variant="ghost"
        size="icon"
        className="lg:hidden"
        id="console-nav-button"
        onClick={onOpenNav}
        aria-label="Open navigation"
        aria-haspopup="dialog"
      >
        <Menu aria-hidden />
      </Button>
      <BrandBlock
        section={section}
        className="lg:min-w-[calc(var(--sidebar-w)-1.5rem)]"
      />
      {product && page ? (
        <ProductSwitcher
          products={products}
          current={product}
          page={page}
          open={switcherOpen}
          onOpenChange={onSwitcherOpenChange}
        />
      ) : null}
      <EnvironmentBadge environment={me.environment} />
      <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-1.5">
        <button
          type="button"
          onClick={onOpenPalette}
          aria-label="Search or jump to"
          aria-keyshortcuts="Meta+K Control+K"
          className={cn(
            "flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-sm text-fg-muted sm:px-2.5",
            "hover:bg-hover hover:text-fg-strong focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus",
          )}
        >
          <Search aria-hidden className="size-4" />
          <span className="hidden md:inline">Search or jump to…</span>
          {/* The shortcut hint joins the label only from lg: at 768–1023 px its ~40 px were the
              product switcher's last slack, and with whole-pixel glyph advances (Chromium on
              Linux) the switcher's chevron was pushed out of its border box. */}
          <Kbd keys="⌘K" className="hidden lg:flex" />
        </button>
        {/* Under 640 px the bar has no room for it; the account menu keeps "Docs home". */}
        <Button variant="ghost" size="sm" asChild className="max-sm:hidden">
          <a href={docsHref} target="_blank" rel="noreferrer">
            <BookOpen aria-hidden />
            Docs
          </a>
        </Button>
        <ThemeMenu />
        <UserMenu
          me={me}
          version={version}
          onShortcuts={onShortcuts}
          onSignOut={onSignOut}
        />
      </div>
    </header>
  );
}
