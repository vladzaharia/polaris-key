import * as React from "react";
import { Command } from "cmdk";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Search } from "lucide-react";
import { useAdmin } from "../../context.js";
import { cn } from "../../lib/cn.js";
import { StatusPill } from "../../ui/StatusPill.js";
import { useProduct, useProducts } from "../data/hooks.js";
import { pageOfRoute, slugOfRoute } from "../routes.js";
import { navigate, useLocation } from "../router.js";
import { Kbd, LiveRegion, ServiceDots, type ProductLike } from "./bits.js";
import { rankPalette } from "./palette/rank.js";
import {
  readRecents,
  pushRecent,
  resolveRecents,
  useRecordRecents,
} from "./palette/recents.js";
import { PALETTE_GROUPS, usePaletteItems } from "./palette/registry.js";
import type {
  PaletteContext,
  PaletteItem,
  PanelRender,
} from "./palette/types.js";

// The sources and the filter live in `palette/`; these names stay importable from here.
export { navigationSource, productSource } from "./palette/navigation.js";
export { filterItems } from "./palette/rank.js";
export type { PaletteItem } from "./palette/types.js";

/**
 * What the palette's sources read: the product on screen (when the session has it), what it runs,
 * and every product but the system one. Read here rather than passed in, so a source can be added
 * without touching the shell.
 */
function usePaletteContext(): PaletteContext {
  const { me } = useAdmin();
  const { route } = useLocation();
  const routeSlug = slugOfRoute(route);
  const slug =
    routeSlug !== null && me.products.some((p) => p.slug === routeSlug)
      ? routeSlug
      : null;
  const product = useProduct(slug).data;
  const list = useProducts().data;
  const products: ProductLike[] = (list ?? me.products).filter(
    (p) => !(p as { system?: boolean }).system,
  );
  return {
    slug,
    productName:
      product?.name ?? me.products.find((p) => p.slug === slug)?.name ?? null,
    services: product?.services ?? null,
    features: product ? { packageFeeds: product.packageFeeds === true } : null,
    products,
    page: pageOfRoute(route),
    me,
  };
}

/** Open a console hash in a new tab (⌘↵ / Ctrl+↵ on a row that goes somewhere). */
function openInNewTab(href: string): void {
  window.open(
    `${window.location.pathname}${window.location.search}${href}`,
    "_blank",
    "noopener",
  );
}

/**
 * The command palette (EXPERIENCE.md §0.3 J-1, ADMIN.md §2.2), on `cmdk` inside a dialog.
 *
 * Rows come from the source registry (`palette/registry.ts`): the current product's pages, actions
 * (Create license…, Turn on <Service>, theme, docs), other products, and the Platform pages, which
 * show only on a match. The last five things opened (rows run here, and records opened anywhere)
 * are pinned first. `⌘K`/`Ctrl+K` toggles it and `/` opens it (shortcuts.tsx); `↵` runs a row,
 * `⌘↵` opens a page in a new tab; a live region announces the result count. On a phone it fills
 * the screen.
 *
 * `items` are rows a caller adds to the sources' own; a row whose id a source already offers is
 * dropped, so the shell's navigation and product rows never show twice.
 */
export function CommandPalette({
  open,
  onOpenChange,
  items: extra,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items?: PaletteItem[];
}): React.ReactElement {
  const ctx = usePaletteContext();
  const { route } = useLocation();
  useRecordRecents(route, route.kind !== "product" || ctx.slug !== null);

  const [query, setQuery] = React.useState("");
  const [selected, setSelected] = React.useState("");
  const [recentIds, setRecentIds] = React.useState<string[]>([]);
  const [panel, setPanel] = React.useState<{
    render: PanelRender;
    open: boolean;
    key: number;
  } | null>(null);
  React.useEffect(() => {
    if (open) {
      setQuery("");
      setRecentIds(readRecents());
    }
  }, [open]);

  const items = usePaletteItems(ctx, query, extra);
  const recents = resolveRecents(recentIds, items, ctx.products);
  const groups = rankPalette(items, recents, query, PALETTE_GROUPS);
  const count = groups.reduce((n, g) => n + g.items.length, 0);
  const valueOf = (heading: string, item: PaletteItem): string =>
    `${heading}:${item.id}`;
  const byValue = new Map(
    groups.flatMap((g) => g.items.map((i) => [valueOf(g.heading, i), i])),
  );

  const run = (item: PaletteItem, newTab = false): void => {
    setRecentIds(pushRecent(item.id, recentIds));
    onOpenChange(false);
    if (newTab && item.href && !item.perform) {
      openInNewTab(item.href);
      return;
    }
    if (item.perform) {
      item.perform({
        navigate: (href) => navigate(href),
        openPanel: (render) =>
          setPanel((p) => ({ render, open: true, key: (p?.key ?? 0) + 1 })),
      });
      return;
    }
    if (item.href) navigate(item.href);
  };

  return (
    <>
      <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs animate-pk-overlay-in" />
          <DialogPrimitive.Content
            aria-describedby={undefined}
            className={cn(
              // A phone gets the whole screen (EXPERIENCE.md §3); wider screens a centred panel.
              "fixed inset-0 z-50 flex flex-col overflow-hidden bg-popover pt-[env(safe-area-inset-top,0px)] text-popover-foreground animate-pk-in",
              "sm:inset-auto sm:left-1/2 sm:top-[12vh] sm:w-[calc(100vw-1rem)] sm:max-w-xl sm:-translate-x-1/2 sm:rounded-lg sm:border sm:border-border sm:pt-0 sm:shadow-pk-lg",
            )}
          >
            <DialogPrimitive.Title className="sr-only">
              Command palette
            </DialogPrimitive.Title>
            <Command
              label="Search or jump to"
              shouldFilter={false}
              loop
              value={selected}
              onValueChange={setSelected}
              // Ctrl+K is the palette toggle here, not cmdk's vim "previous item".
              vimBindings={false}
              onKeyDown={(e) => {
                if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
                const item = byValue.get(selected);
                if (!item) return;
                e.preventDefault();
                run(item, true);
              }}
              className="flex min-h-0 flex-1 flex-col"
            >
              <div className="flex items-center gap-2 border-b border-border px-3">
                <Search aria-hidden className="size-4 shrink-0 text-fg-muted" />
                <Command.Input
                  value={query}
                  onValueChange={setQuery}
                  aria-label="Search or jump to"
                  placeholder="Search or jump to…"
                  className="h-12 w-full bg-transparent text-sm outline-hidden focus-visible:ring-0 focus-visible:ring-offset-0 placeholder:text-fg-subtle"
                />
                <DialogPrimitive.Close className="shrink-0 rounded-sm px-1 py-1 text-sm text-fg-muted hover:text-fg-strong focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus sm:hidden">
                  Cancel
                </DialogPrimitive.Close>
              </div>
              <Command.List
                label="Results"
                className="min-h-0 flex-1 overflow-y-auto p-1 sm:max-h-[min(60vh,26rem)] sm:flex-none"
              >
                <Command.Empty className="px-3 py-6 text-center text-sm text-fg-muted">
                  Nothing matches “{query.trim()}”.
                </Command.Empty>
                {groups.map((g) => (
                  <Command.Group
                    key={g.heading}
                    heading={g.heading}
                    className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-fg-muted"
                  >
                    {g.items.map((item) => (
                      <Command.Item
                        key={valueOf(g.heading, item)}
                        value={valueOf(g.heading, item)}
                        onSelect={() => run(item)}
                        className="flex cursor-pointer items-center gap-2.5 rounded-sm px-2 py-2 text-sm data-[selected=true]:bg-accent-subtle data-[selected=true]:text-fg-strong"
                      >
                        <span className="text-fg-muted">{item.icon}</span>
                        <span className="min-w-0 truncate">{item.label}</span>
                        <span className="min-w-0 truncate text-xs text-fg-muted">
                          {item.detail}
                        </span>
                        {item.product ? (
                          <ServiceDots product={item.product} />
                        ) : null}
                        {item.issue ? (
                          <StatusPill
                            tone={item.issue.tone}
                            size="sm"
                            className="ml-auto shrink-0"
                          >
                            {item.issue.label}
                          </StatusPill>
                        ) : null}
                        {item.shortcut ? <Kbd keys={item.shortcut} /> : null}
                      </Command.Item>
                    ))}
                  </Command.Group>
                ))}
              </Command.List>
            </Command>
            <div
              aria-hidden
              className="hidden items-center justify-end gap-4 border-t border-border px-3 py-2 text-xs text-fg-muted sm:flex"
            >
              <span className="flex items-center gap-1.5">
                <Kbd keys="↵" className="ml-0" />
                open
              </span>
              <span className="flex items-center gap-1.5">
                <Kbd keys="⌘↵" className="ml-0" />
                new tab
              </span>
              <span className="flex items-center gap-1.5">
                <Kbd keys="esc" className="ml-0" />
                close
              </span>
            </div>
            <LiveRegion
              message={
                open
                  ? count === 0
                    ? "No results"
                    : `${count} result${count === 1 ? "" : "s"}`
                  : ""
              }
            />
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
      {panel ? (
        <React.Suspense key={panel.key} fallback={null}>
          {panel.render({
            open: panel.open,
            onOpenChange: (o) => setPanel((p) => (p ? { ...p, open: o } : p)),
          })}
        </React.Suspense>
      ) : null}
    </>
  );
}
