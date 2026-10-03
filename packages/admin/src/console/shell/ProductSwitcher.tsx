import * as React from "react";
import { Command } from "cmdk";
import { Popover } from "radix-ui";
import { ChevronsUpDown, Boxes, Plus } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { sameViewIn, type ProductPageId, type ServiceState } from "../nav.js";
import { navigate } from "../router.js";
import { productPage, r } from "../routes.js";
import { PREF_KEYS, readPref, stringArray, writePref } from "../storage.js";
import { attentionCount, ServiceDots, type ProductLike } from "./bits.js";

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

/**
 * The product switcher (ADMIN.md §2.2, components.md §1.3): a combobox with type-to-filter, the
 * last five products, service dots and an attention count. Choosing a product keeps the current
 * page when that product runs the page's service, and otherwise lands on its Overview (fixes
 * SH-11; the rule is `sameViewIn` in nav.ts). `g p` opens it.
 */
export function ProductSwitcher({
  products,
  current,
  page,
  open,
  onOpenChange,
}: {
  products: ProductLike[];
  current: ProductLike;
  page: ProductPageId;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.ReactElement {
  const [query, setQuery] = React.useState("");
  React.useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const select = (p: ProductLike): void => {
    pushRecent(p.slug);
    onOpenChange(false);
    navigate(productPage(p.slug, sameViewIn(page, servicesOf(p))));
  };

  const recent = readRecent()
    .map((slug) => products.find((p) => p.slug === slug))
    .filter(
      (p): p is ProductLike => p !== undefined && p.slug !== current.slug,
    );
  const q = query.trim().toLowerCase();
  const matches = (p: ProductLike): boolean =>
    q === "" ||
    p.name.toLowerCase().includes(q) ||
    p.slug.toLowerCase().includes(q);

  const row = (p: ProductLike, group: string): React.ReactElement => {
    const attention = attentionCount(p);
    return (
      <Command.Item
        key={`${group}:${p.slug}`}
        value={`${group}:${p.slug}`}
        onSelect={() => select(p)}
        className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm data-[selected=true]:bg-accent-subtle data-[selected=true]:text-fg-strong"
      >
        <span className="min-w-0 flex-1 truncate">
          {p.name}{" "}
          <span className="font-mono text-xs text-fg-muted">{p.slug}</span>
        </span>
        <ServiceDots product={p} />
        {attention > 0 ? (
          <span
            className="rounded-full bg-warning-subtle px-1.5 text-xs font-bold text-warning"
            aria-label={`${attention} need attention`}
          >
            {attention}
          </span>
        ) : null}
        {p.slug === current.slug ? (
          <span className="sr-only">(current)</span>
        ) : null}
      </Command.Item>
    );
  };

  const filtered = products.filter(matches);
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={`Product: ${current.name} (${current.slug}). Change product`}
          className={cn(
            "flex min-w-0 items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm",
            "hover:bg-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus",
          )}
        >
          <span className="truncate font-bold text-fg-strong">
            {current.name}
          </span>
          <span className="hidden font-mono text-xs text-fg-muted md:inline">
            {current.slug}
          </span>
          <ServiceDots product={current} className="hidden md:inline-flex" />
          <ChevronsUpDown
            aria-hidden
            className="size-3.5 shrink-0 text-fg-muted"
          />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          className="z-50 w-80 max-w-[calc(100vw-1rem)] rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-pk-md animate-pk-in"
        >
          <Command label="Find a product" shouldFilter={false} loop>
            <Command.Input
              value={query}
              onValueChange={setQuery}
              placeholder="Find a product…"
              aria-label="Find a product"
              className="mb-1 w-full rounded-sm border border-input bg-transparent px-2 py-1.5 text-sm outline-hidden focus-visible:ring-2 focus-visible:ring-focus"
            />
            <Command.List label="Products" className="max-h-72 overflow-y-auto">
              <Command.Empty className="px-2 py-3 text-sm text-fg-muted">
                No product matches “{query}”.
              </Command.Empty>
              {q === "" && recent.length > 0 ? (
                <Command.Group
                  heading="Recent"
                  className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-fg-muted"
                >
                  {recent.map((p) => row(p, "recent"))}
                </Command.Group>
              ) : null}
              {filtered.length > 0 ? (
                <Command.Group
                  heading="All products"
                  className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-fg-muted"
                >
                  {filtered.map((p) => row(p, "all"))}
                </Command.Group>
              ) : null}
            </Command.List>
          </Command>
          <div className="mt-1 flex gap-1 border-t border-border pt-1">
            <a
              href={r.products()}
              onClick={() => onOpenChange(false)}
              className="flex flex-1 items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus"
            >
              <Boxes aria-hidden className="size-4" />
              All products
            </a>
            <a
              href={r.productNew()}
              onClick={() => onOpenChange(false)}
              className="flex flex-1 items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus"
            >
              <Plus aria-hidden className="size-4" />
              New product
            </a>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
