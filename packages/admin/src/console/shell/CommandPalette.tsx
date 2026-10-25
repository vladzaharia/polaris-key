import * as React from "react";
import { Command } from "cmdk";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Search } from "lucide-react";
import type { Me } from "../../api.js";
import { cn } from "../../lib/cn.js";
import { StatusPill } from "../../ui/StatusPill.js";
import { useProduct, useProducts } from "../data/hooks.js";
import { pageOfRoute, slugOfRoute } from "../routes.js";
import { navFeaturesOf } from "../nav.js";
import { navigate, useLocation } from "../router.js";
import { LAND_EVENT } from "../useSettingTarget.js";
import { Kbd } from "../../ui/Kbd.js";
import { LiveRegion } from "../../ui/LiveRegion.js";
import { ServiceDots, type ProductLike } from "./bits.js";
import { rankPalette } from "./palette/rank.js";
import {
  readRecents,
  pushRecent,
  rememberRecordName,
  resolveRecents,
  useRecordRecents,
} from "./palette/recents.js";
import { PALETTE_GROUPS, usePaletteItems } from "./palette/registry.js";
import type {
  PaletteContext,
  PaletteItem,
  PanelRender,
} from "./palette/types.js";

/**
 * What the palette's sources read: the product on screen (when the session has it), what it runs,
 * and every product but the system one. Read here from the session rather than passed in piece by
 * piece, so a source can be added without touching the shell.
 */
function usePaletteContext(me: Me): PaletteContext {
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
    features: navFeaturesOf(product),
    products,
    page: pageOfRoute(route),
    me,
  };
}

/** `value`, settled: it follows after `ms`, and clearing it is immediate. */
function useDebounced(value: string, ms: number): string {
  const [settled, setSettled] = React.useState(value);
  React.useEffect(() => {
    if (value === "") {
      setSettled("");
      return;
    }
    const t = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return settled;
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
 * Motion (MO-08, S-23 §6.1): the panel and scrim enter and exit through src/motion.css (keyed on
 * `animate-pk-in` / `animate-pk-overlay-in`); the result list never animates while typing (no
 * stagger, no list transition), and the selection highlight eases between rows at `micro`.
 *
 * `items` are rows a caller adds to the sources' own; a row whose id a source already offers is
 * dropped, so the shell's navigation and product rows never show twice. `initialQuery` is typed
 * in each time it opens (a not-found page's dead segment), selected, so typing replaces it.
 */
export function CommandPalette({
  me,
  open,
  onOpenChange,
  initialQuery = "",
  items: extra,
}: {
  /** The session: which products the palette may offer. */
  me: Me;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The query the palette opens with. */
  initialQuery?: string;
  items?: PaletteItem[];
}): React.ReactElement {
  const ctx = usePaletteContext(me);
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
  const inputRef = React.useRef<HTMLInputElement>(null);
  // Where focus was before the palette opened, and whether a pick moved it on: Radix has no
  // trigger to return to (the palette opens from ⌘K or a button that does not own it).
  const opener = React.useRef<HTMLElement | null>(null);
  const moved = React.useRef(false);
  // Reset on open, during render rather than in an effect, so the input mounts holding the
  // initial query and the dialog's open focus can select it.
  const [wasOpen, setWasOpen] = React.useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      opener.current = document.activeElement as HTMLElement | null;
      moved.current = false;
      setQuery(initialQuery);
      setRecentIds(readRecents());
    }
  }

  const items = usePaletteItems(ctx, query, extra);
  const recents = resolveRecents(recentIds, items, ctx.products);
  const groups = rankPalette(items, recents, query, PALETTE_GROUPS);
  const count = groups.reduce((n, g) => n + g.items.length, 0);
  // The announced count is of results, not of the "See all" row, and says when a group is capped.
  const cappedRow = groups.flatMap((g) => g.items).find((i) => i.capped);
  // A status line (searching, nothing found, failed) says something and is no result.
  const statusRows = groups
    .flatMap((g) => g.items)
    .filter((i) => !i.capped && (i.inert || i.keepOpen));
  const results = count - (cappedRow ? 1 : 0) - statusRows.length;
  const announced = !open
    ? ""
    : count === 0
      ? "No results"
      : results === 0 && statusRows.length > 0
        ? statusRows[0]!.label
        : `${results} result${results === 1 ? "" : "s"}${
            cappedRow?.capped
              ? `, ${cappedRow.capped.shown} of ${cappedRow.capped.total} ${cappedRow.capped.noun}`
              : ""
          }`;
  // Typing re-ranks on every key: announce when the person pauses, not on each letter.
  const spoken = useDebounced(announced, 500);
  const valueOf = (heading: string, item: PaletteItem): string =>
    `${heading}:${item.id}`;
  const byValue = new Map(
    groups.flatMap((g) => g.items.map((i) => [valueOf(g.heading, i), i])),
  );

  // The row Enter opens when nothing is picked: the first that does something.
  const firstRow =
    groups
      .flatMap((g) => g.items.map((i) => [g.heading, i] as const))
      .find(([, i]) => !i.inert) ??
    (groups[0] && ([groups[0].heading, groups[0].items[0]!] as const));
  const firstValue = firstRow ? valueOf(firstRow[0], firstRow[1]) : undefined;

  // cmdk points the input's `aria-activedescendant` at the selected row's id, but only re-reads it
  // when the selected *value* changes. Re-ranking can remount the row under the same value (the
  // list regroups), which leaves the attribute on an id that no longer exists (axe: critical). So
  // after each render the attribute is set from the row that is selected now.
  React.useEffect(() => {
    if (!open) return;
    const sync = (): void => {
      const input = inputRef.current;
      const root = input?.closest("[cmdk-root]");
      if (!input || !root) return;
      const row = root.querySelector<HTMLElement>(
        "[cmdk-item][aria-selected='true']",
      );
      // The input and the list both carry the attribute.
      for (const el of [input, root.querySelector("[cmdk-list]")]) {
        if (!el) continue;
        if (row?.id) el.setAttribute("aria-activedescendant", row.id);
        else el.removeAttribute("aria-activedescendant");
      }
    };
    sync();
    const frame = requestAnimationFrame(sync);
    return () => cancelAnimationFrame(frame);
  });

  /** Go to a hash; a jump to the one already shown lands on its target again. */
  const go = (href: string): void => {
    moved.current = true;
    if (window.location.hash === href)
      window.setTimeout(() => window.dispatchEvent(new Event(LAND_EVENT)), 60);
    else navigate(href);
  };

  const run = (item: PaletteItem, newTab = false): void => {
    if (item.inert) return;
    if (item.keepOpen) {
      item.perform?.({
        navigate: (href) => navigate(href),
        openPanel: () => {},
      });
      return;
    }
    // An entity row is a record: the route hook records the visit, so it takes one slot, and
    // the name the operator picked is kept for it.
    if (item.id.startsWith("entity:")) {
      if (item.href && item.recordName)
        rememberRecordName(item.href, item.recordName);
    } else setRecentIds(pushRecent(item.id, recentIds));
    onOpenChange(false);
    if (newTab && item.href && !item.perform) {
      openInNewTab(item.href);
      return;
    }
    if (item.perform) {
      item.perform({
        navigate: go,
        openPanel: (render) =>
          setPanel((p) => ({ render, open: true, key: (p?.key ?? 0) + 1 })),
      });
      return;
    }
    if (item.href) go(item.href);
  };

  return (
    <>
      <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-(--polaris-key-page-dark)/60 backdrop-blur-xs animate-pk-overlay-in" />
          <DialogPrimitive.Content
            aria-describedby={undefined}
            onCloseAutoFocus={(e) => {
              e.preventDefault();
              if (!moved.current) opener.current?.focus();
            }}
            onOpenAutoFocus={(e) => {
              if (!initialQuery) return;
              e.preventDefault();
              inputRef.current?.focus();
              inputRef.current?.select();
            }}
            className={cn(
              // A phone gets the whole screen (EXPERIENCE.md §3); wider screens a centred panel.
              "fixed inset-0 z-50 flex flex-col overflow-hidden bg-surface-overlay pt-[env(safe-area-inset-top,0px)] text-fg animate-pk-in",
              "sm:inset-auto sm:start-1/2 sm:top-[12vh] sm:w-[calc(100%-1rem)] sm:max-w-xl sm:-translate-x-1/2 sm:rtl:translate-x-1/2 sm:rounded-lg sm:border sm:border-border sm:pt-0 sm:shadow-elevation-3",
            )}
          >
            <DialogPrimitive.Title className="sr-only">
              Command palette
            </DialogPrimitive.Title>
            <Command
              label="Search or jump to"
              shouldFilter={false}
              loop
              // A selection the new ranking dropped would leave `aria-activedescendant` on a row
              // that no longer exists: fall back to the first row of what is shown (B-003).
              value={byValue.has(selected) ? selected : (firstValue ?? "")}
              onValueChange={setSelected}
              // Ctrl+K is the palette toggle here, not cmdk's vim "previous item".
              vimBindings={false}
              onKeyDown={(e) => {
                if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
                const item = byValue.get(
                  byValue.has(selected) ? selected : (firstValue ?? ""),
                );
                if (!item) return;
                e.preventDefault();
                run(item, true);
              }}
              className="flex min-h-0 flex-1 flex-col"
            >
              <div className="flex items-center gap-2 border-b border-border px-3">
                <Search aria-hidden className="size-4 shrink-0 text-fg-muted" />
                <Command.Input
                  ref={inputRef}
                  value={query}
                  onValueChange={setQuery}
                  aria-label="Search or jump to"
                  placeholder="Search or jump to…"
                  className="h-12 w-full bg-transparent text-sm outline-hidden placeholder:text-fg-subtle"
                />
                <DialogPrimitive.Close className="shrink-0 rounded-sm px-1 py-1 text-sm text-fg-muted hover:text-fg-strong focus-visible:outline-2 focus-visible:outline-focus sm:hidden">
                  Cancel
                </DialogPrimitive.Close>
              </div>
              <Command.List
                label="Results"
                // An empty listbox fails axe (aria-required-children): the message sits beside it.
                hidden={count === 0}
                className="min-h-0 flex-1 overflow-y-auto p-1 sm:max-h-[min(60vh,26rem)] sm:flex-none"
              >
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
                        disabled={item.inert}
                        onSelect={() => run(item)}
                        className="flex cursor-pointer data-[disabled=true]:cursor-default items-center gap-2 rounded-sm px-2 py-2 text-sm transition-colors duration-(--pk-duration-micro) ease-standard data-[selected=true]:bg-accent-subtle data-[disabled=true]:bg-transparent! data-[selected=true]:text-fg-strong forced-colors:data-[selected=true]:[outline:2px_solid_Highlight] forced-colors:data-[selected=true]:-outline-offset-2"
                      >
                        <span className="text-fg-muted">{item.icon}</span>
                        <span
                          className={cn(
                            "flex min-w-0 flex-col",
                            // An entity row stacks name over detail at every width: the product
                            // is what tells two of them apart.
                            item.id.startsWith("entity:")
                              ? "flex-1"
                              : "max-sm:flex-1 sm:contents",
                          )}
                        >
                          <span
                            className={cn(
                              "min-w-0",
                              item.inert ? "whitespace-normal" : "sm:truncate",
                            )}
                          >
                            {item.label}
                            {item.labelMono ? (
                              <>
                                {" "}
                                <code className="font-mono tracking-wider">
                                  {item.labelMono}
                                </code>
                              </>
                            ) : null}
                          </span>
                          <span className="min-w-0 text-xs text-fg-muted sm:truncate">
                            {item.detail}
                          </span>
                        </span>
                        {item.product ? (
                          <ServiceDots product={item.product} />
                        ) : null}
                        {item.issue ? (
                          <StatusPill
                            tone={item.issue.tone}
                            size="sm"
                            className="ms-auto shrink-0"
                          >
                            {item.issue.label}
                          </StatusPill>
                        ) : null}
                        {item.shortcut ? (
                          // A phone has no keyboard to press them with.
                          <Kbd
                            keys={item.shortcut}
                            className="hidden sm:flex"
                          />
                        ) : null}
                      </Command.Item>
                    ))}
                  </Command.Group>
                ))}
              </Command.List>
              {count === 0 ? (
                <p className="px-3 py-6 text-center text-sm text-fg-muted">
                  Nothing matches “{query.trim()}”.
                </p>
              ) : null}
            </Command>
            <div
              aria-hidden
              className="hidden items-center justify-end gap-4 border-t border-border px-3 py-2 text-xs text-fg-muted sm:flex"
            >
              <span className="flex items-center gap-1.5">
                <Kbd keys="↵" className="ms-0" />
                open
              </span>
              <span className="flex items-center gap-1.5">
                <Kbd keys="⌘↵" className="ms-0" />
                new tab
              </span>
              <span className="flex items-center gap-1.5">
                <Kbd keys="esc" className="ms-0" />
                close
              </span>
            </div>
            <LiveRegion message={spoken} />
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
