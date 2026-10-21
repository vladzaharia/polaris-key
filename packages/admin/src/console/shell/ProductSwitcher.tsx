import * as React from "react";
import { Command } from "cmdk";
import { Popover } from "radix-ui";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { PolarisMark } from "@polaris-key/brand/react";
import { ProductLogo } from "../../ui/ProductLogo.js";
import { cn } from "../../lib/cn.js";
import { sameViewIn, type ProductPageId, type ServiceState } from "../nav.js";
import { navigate } from "../router.js";
import { productPage, r } from "../routes.js";
import { PREF_KEYS, readPref, stringArray, writePref } from "../storage.js";
import { ServiceDots, type ProductLike } from "./bits.js";
import type { ProductPresentation } from "../../api.js";
import { useAttention } from "../data/hooks.js";

const RECENT_MAX = 5;

function readRecent(): string[] {
  return readPref(PREF_KEYS.recentProducts, stringArray, []);
}

function pushRecent(slug: string): void {
  writePref(
    PREF_KEYS.recentProducts,
    [slug, ...readRecent().filter((s) => s !== slug)].slice(0, RECENT_MAX),
  );
}

function servicesOf(p: ProductLike): ServiceState {
  return ("services" in p ? (p.services ?? null) : null) as ServiceState;
}

/** What the sidebar's context header needs: the product in scope (`null` is Platform). */
export interface SwitcherContext {
  products: ProductLike[];
  /** The product in scope, or `null` in the Platform context. */
  current: ProductLike | null;
  /** The page the switcher keeps; `null` off a product. */
  page: ProductPageId | null;
  /** Controlled (`g p`); the drawer's copy leaves both off and keeps its own state. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** ST-29: the member holds the Platform area (its pages and New product). Default: yes. */
  platform?: boolean;
  /** Called after the switcher navigates (the phone drawer closes, so the page can take focus). */
  onNavigate?: () => void;
}

/** The product's identity tile: its logo, or the Polaris mark for Platform. */
function ContextTile({
  current,
  size,
}: {
  current: ProductLike | null;
  size: 32 | 40;
}): React.ReactElement {
  return current ? (
    <ProductLogo
      name={current.name}
      presentation={
        (current as { presentation?: ProductPresentation }).presentation
      }
      size={size}
      className={cn("shrink-0", size === 40 ? "size-[40px]!" : "size-[32px]!")}
    />
  ) : (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-lg border border-border bg-surface-sunken",
        size === 40 ? "size-[40px]" : "size-[32px]",
      )}
    >
      <PolarisMark kind="key" size={size === 40 ? 24 : 20} theme="mono" />
    </span>
  );
}

/**
 * The context switcher (ADMIN.md §2.2, components.md §1.3, ST-45): the sidebar's pinned header.
 * A 72 px bordered card names the context (the product with its slug, or Platform with the
 * product count) and opens a combobox with type-to-filter, Platform first, the last five
 * products, service dots, an attention count and New product. Choosing a product keeps the
 * current page when that product runs the page's service, and otherwise lands on its Overview
 * (`sameViewIn`). `g p` opens it. In the icon rail the card is its tile alone.
 */
export function ProductSwitcher({
  products,
  current,
  page,
  open: openProp,
  onOpenChange: onOpenChangeProp,
  platform = true,
  onNavigate,
  rail = false,
}: SwitcherContext & { rail?: boolean }): React.ReactElement {
  // Navigating from the menu: the route's heading takes focus, not the card Radix would restore.
  const navigated = React.useRef(false);
  const go = (to: string): void => {
    navigated.current = true;
    onOpenChange(false);
    navigate(to);
    onNavigate?.();
  };
  const [own, setOwn] = React.useState(false);
  const open = openProp ?? own;
  const onOpenChange = onOpenChangeProp ?? setOwn;
  const [query, setQuery] = React.useState("");
  React.useEffect(() => {
    if (!open) setQuery("");
  }, [open]);
  // The server's attention read, counted per product (ST-44); none until it answers.
  const attentionItems = useAttention();
  const counts = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const a of attentionItems.data ?? [])
      m.set(a.product.slug, (m.get(a.product.slug) ?? 0) + 1);
    return m;
  }, [attentionItems.data]);

  const select = (p: ProductLike): void => {
    pushRecent(p.slug);
    go(
      productPage(p.slug, page ? sameViewIn(page, servicesOf(p)) : "overview"),
    );
  };

  const recent = readRecent()
    .map((slug) => products.find((p) => p.slug === slug))
    .filter(
      (p): p is ProductLike => p !== undefined && p.slug !== current?.slug,
    );
  const q = query.trim().toLowerCase();
  const matches = (p: ProductLike): boolean =>
    q === "" ||
    p.name.toLowerCase().includes(q) ||
    p.slug.toLowerCase().includes(q);

  const row = (p: ProductLike, group: string): React.ReactElement => {
    const attention = counts.get(p.slug) ?? 0;
    return (
      <Command.Item
        key={`${group}:${p.slug}`}
        value={`${group}:${p.slug}`}
        onSelect={() => select(p)}
        className="flex min-h-10 cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm data-[selected=true]:bg-accent-subtle data-[selected=true]:text-fg-strong"
      >
        <span
          title={`${p.name} (${p.slug})`}
          className={cn(
            "min-w-0 flex-1 truncate",
            p.slug === current?.slug && "font-medium text-fg-strong",
          )}
        >
          {p.name}{" "}
          <span className="font-mono text-xs font-normal text-fg-muted">
            {p.slug}
          </span>
        </span>
        <ServiceDots product={p} className="shrink-0" />
        {attention > 0 ? (
          <span className="rounded-full bg-warning-subtle px-1.5 text-xs font-medium text-warning">
            {attention}
            <span className="sr-only">
              {attention === 1 ? " needs attention" : " need attention"}
            </span>
          </span>
        ) : null}
        {p.slug === current?.slug ? (
          <>
            <Check aria-hidden className="size-4 shrink-0 text-accent-fg" />
            <span className="sr-only">(current)</span>
          </>
        ) : null}
      </Command.Item>
    );
  };

  // Recent products lead the menu; Products lists the rest.
  const recentSlugs = new Set(q === "" ? recent.map((p) => p.slug) : []);
  const filtered = products.filter(
    (p) => matches(p) && !recentSlugs.has(p.slug),
  );
  const groupHeading =
    "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-fg-muted";
  const link =
    "flex min-h-10 items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent-subtle focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-fg";
  const name = current ? current.name : platform ? "Platform" : "All products";
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>
        <button
          type="button"
          data-context-card=""
          aria-label={
            current
              ? `Product: ${current.name} (${current.slug}). Change product`
              : "Platform. Change product"
          }
          title={name}
          className={cn(
            "flex w-full min-w-0 items-center overflow-hidden rounded-lg border border-border text-left text-sm",
            "hover:bg-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus",
            rail ? "min-h-12 justify-center" : "min-h-[72px] gap-3 px-3 py-3",
          )}
        >
          <ContextTile current={current} size={rail ? 32 : 40} />
          {rail ? null : (
            <>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="break-words font-medium text-fg-strong">
                  {name}
                </span>
                <span
                  className={cn(
                    "break-all text-xs text-fg-muted",
                    current && "font-mono",
                  )}
                >
                  {current
                    ? current.slug
                    : `${products.length} ${products.length === 1 ? "product" : "products"}`}
                </span>
              </span>
              <ChevronsUpDown
                aria-hidden
                className="size-3.5 shrink-0 text-fg-muted"
              />
            </>
          )}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          aria-label="Switch product"
          onCloseAutoFocus={(e) => {
            if (navigated.current) {
              navigated.current = false;
              e.preventDefault();
            }
          }}
          className="z-50 w-80 max-w-[calc(100vw-1rem)] rounded-lg border border-border bg-surface-overlay p-1 text-fg shadow-elevation-2 animate-pk-in"
        >
          <Command label="Find a product" shouldFilter={false} loop>
            <Command.Input
              value={query}
              onValueChange={setQuery}
              placeholder="Find a product…"
              aria-label="Find a product"
              className="mb-1 w-full rounded-sm border border-border-strong bg-transparent px-2 py-1.5 text-sm outline-hidden focus-visible:ring-2 focus-visible:ring-focus"
            />
            <Command.List label="Products" className="max-h-72 overflow-y-auto">
              <Command.Empty className="px-2 py-3 text-sm text-fg-muted">
                No product matches “{query}”.
              </Command.Empty>
              {platform && (q === "" || "platform".includes(q)) ? (
                <Command.Group>
                  <Command.Item
                    value="platform"
                    onSelect={() => go(r.home())}
                    className="flex min-h-10 cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm data-[selected=true]:bg-accent-subtle data-[selected=true]:text-fg-strong"
                  >
                    <PolarisMark kind="key" size={16} theme="mono" />
                    <span
                      className={cn(
                        "flex-1",
                        !current && "font-medium text-fg-strong",
                      )}
                    >
                      Platform
                    </span>
                    {!current ? (
                      <>
                        <Check
                          aria-hidden
                          className="size-4 shrink-0 text-accent-fg"
                        />
                        <span className="sr-only">(current)</span>
                      </>
                    ) : null}
                  </Command.Item>
                </Command.Group>
              ) : null}
              {q === "" && recent.length > 0 ? (
                <Command.Group heading="Recent" className={groupHeading}>
                  {recent.map((p) => row(p, "recent"))}
                </Command.Group>
              ) : null}
              {filtered.length > 0 ? (
                <Command.Group heading="Products" className={groupHeading}>
                  {filtered.map((p) => row(p, "all"))}
                </Command.Group>
              ) : null}
            </Command.List>
          </Command>
          {platform ? (
            <div className="mt-1 flex flex-col gap-0.5 border-t border-border pt-1">
              <a
                href={r.productNew()}
                onClick={() => {
                  navigated.current = true;
                  onOpenChange(false);
                  onNavigate?.();
                }}
                className={link}
              >
                <Plus aria-hidden className="size-4 shrink-0" />
                New product
              </a>
            </div>
          ) : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
