import * as React from "react";
import { Command } from "cmdk";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Box, Search } from "lucide-react";
import { cn } from "../../lib/cn.js";
import {
  navItems,
  type NavFeatures,
  platformItems,
  platformLinks,
  visibleSections,
  type GlobalPageId,
  type ProductPageId,
  type ServiceState,
} from "../nav.js";
import { navigate } from "../router.js";
import { globalPage, productPage } from "../routes.js";
import { PREF_KEYS, readPref, stringArray, writePref } from "../storage.js";
import { Kbd, LiveRegion, ServiceDots, type ProductLike } from "./bits.js";

/** One palette row. `id` is stable across renders (it keys the recents). */
export interface PaletteItem {
  id: string;
  group: "Navigation" | "Products";
  label: string;
  /** Secondary text: the section, or the product slug. */
  detail: string;
  /** Extra words the filter matches. */
  keywords: string;
  icon: React.ReactNode;
  shortcut?: string;
  href: string;
  product?: ProductLike;
}

/**
 * The navigation source (components.md §1.5): every built page of the current product's enabled
 * sections, plus the platform links. Nothing a product does not run is offered.
 */
export function navigationSource(
  slug: string | null,
  productName: string | null,
  services: ServiceState,
  features: NavFeatures = null,
): PaletteItem[] {
  const items: PaletteItem[] = platformLinks().map((p) => {
    const Icon = p.icon;
    return {
      id: `nav:${p.page}`,
      group: "Navigation",
      label: p.label,
      detail: "Platform",
      keywords: "platform",
      icon: <Icon aria-hidden className="size-4" />,
      shortcut: p.page === "home" ? "g h" : undefined,
      href: globalPage(p.page as GlobalPageId),
    };
  });
  for (const p of platformItems()) {
    const Icon = p.icon;
    items.push({
      id: `nav:${p.page}`,
      group: "Navigation",
      label: p.label,
      detail: "Platform",
      keywords: "platform",
      icon: <Icon aria-hidden className="size-4" />,
      href: globalPage(p.page as GlobalPageId),
    });
  }
  if (!slug) return items;
  for (const section of visibleSections(services)) {
    for (const p of navItems(section, features)) {
      const Icon = p.icon;
      items.push({
        id: `nav:${slug}:${p.page}`,
        group: "Navigation",
        label: p.label,
        detail: `${section.label} · ${productName ?? slug}`,
        keywords: `${section.label} ${slug}`,
        icon: <Icon aria-hidden className="size-4" />,
        shortcut: p.shortcut ? `g ${p.shortcut}` : undefined,
        href: productPage(slug, p.page as ProductPageId),
      });
    }
  }
  return items;
}

/** The products source: jump to any product's Overview. */
export function productSource(products: ProductLike[]): PaletteItem[] {
  return products.map((p) => ({
    id: `product:${p.slug}`,
    group: "Products",
    label: p.name,
    detail: p.slug,
    keywords: `${p.slug} product`,
    icon: <Box aria-hidden className="size-4" />,
    href: productPage(p.slug, "overview"),
    product: p,
  }));
}

/** Every query word must appear in the label, the detail or the keywords. Label prefixes rank first. */
export function filterItems(
  items: PaletteItem[],
  query: string,
): PaletteItem[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return items;
  const scored: { item: PaletteItem; score: number; index: number }[] = [];
  items.forEach((item, index) => {
    const label = item.label.toLowerCase();
    const hay = `${label} ${item.detail.toLowerCase()} ${item.keywords.toLowerCase()}`;
    if (!words.every((w) => hay.includes(w))) return;
    const score = label.startsWith(words[0]!)
      ? 0
      : label.includes(words[0]!)
        ? 1
        : 2;
    scored.push({ item, score, index });
  });
  return scored
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((s) => s.item);
}

const RECENT_MAX = 5;

/**
 * The command palette (ADMIN.md §2.2, components.md §1.5), on `cmdk` inside a dialog. Chunk 2
 * ships the navigation and products sources; entities and safe actions arrive with their areas.
 * `⌘K`/`Ctrl+K` or `/` opens it (see shortcuts.tsx); recent commands are pinned first; a live
 * region announces the result count.
 */
export function CommandPalette({
  open,
  onOpenChange,
  items,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: PaletteItem[];
}): React.ReactElement {
  const [query, setQuery] = React.useState("");
  const [recentIds, setRecentIds] = React.useState<string[]>([]);
  React.useEffect(() => {
    if (open) {
      setQuery("");
      setRecentIds(readPref(PREF_KEYS.recentCommands, stringArray, []));
    }
  }, [open]);

  const results = filterItems(items, query);
  const recent =
    query.trim() === ""
      ? recentIds
          .map((id) => items.find((i) => i.id === id))
          .filter((i): i is PaletteItem => i !== undefined)
      : [];
  const recentSet = new Set(recent.map((i) => i.id));
  const rest = results.filter((i) => !recentSet.has(i.id));
  const groups: { heading: string; items: PaletteItem[] }[] = [
    { heading: "Recent", items: recent },
    {
      heading: "Navigation",
      items: rest.filter((i) => i.group === "Navigation"),
    },
    { heading: "Products", items: rest.filter((i) => i.group === "Products") },
  ].filter((g) => g.items.length > 0);
  const count = recent.length + rest.length;

  const run = (item: PaletteItem): void => {
    writePref(
      PREF_KEYS.recentCommands,
      [item.id, ...recentIds.filter((id) => id !== item.id)].slice(
        0,
        RECENT_MAX,
      ),
    );
    onOpenChange(false);
    navigate(item.href);
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs animate-pk-overlay-in" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className={cn(
            "fixed left-1/2 top-[12vh] z-50 w-[calc(100vw-1rem)] max-w-xl -translate-x-1/2 overflow-hidden",
            "rounded-lg border border-border bg-popover text-popover-foreground shadow-pk-lg animate-pk-in",
          )}
        >
          <DialogPrimitive.Title className="sr-only">
            Command palette
          </DialogPrimitive.Title>
          <Command
            label="Search or jump to"
            shouldFilter={false}
            loop
            // Ctrl+K is the palette toggle here, not cmdk's vim "previous item".
            vimBindings={false}
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
            </div>
            <Command.List
              label="Results"
              className="max-h-[min(60vh,26rem)] overflow-y-auto p-1"
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
                      key={`${g.heading}:${item.id}`}
                      value={`${g.heading}:${item.id}`}
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
                      {item.shortcut ? <Kbd keys={item.shortcut} /> : null}
                    </Command.Item>
                  ))}
                </Command.Group>
              ))}
            </Command.List>
          </Command>
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
  );
}
