import * as React from "react";
import { Command } from "cmdk";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Clock, KeyRound, MonitorSmartphone, Search } from "lucide-react";
import { LiveRegion } from "../../ui/LiveRegion.js";
import { Kbd } from "../../ui/Kbd.js";
import { cn } from "../../lib/cn.js";
import type { LibraryProduct } from "../model/library.js";
import { requestHeadingFocus } from "../focus.js";
import { matches } from "../model/libraryView.js";
import { focusPageHeading, href, navigate, resolveHash } from "../router.js";
import { ProductIcon } from "./ProductIcon.js";

/**
 * Jump to a product (§4.27), from 8 products: ⌘K / Ctrl K, the header trigger or the phone
 * search icon. Products, Actions scoped to the top match ("Manage devices for …", "Activate a
 * license"; "Cloud Sync for …" joins with G26), and Recent. A 640 px dialog near the top;
 * full-screen on phones.
 */
const RECENT_KEY = "pk-portal-recent";

function readRecent(): string[] {
  try {
    const v = JSON.parse(
      window.localStorage.getItem(RECENT_KEY) ?? "[]",
    ) as unknown;
    return Array.isArray(v)
      ? v.filter((s): s is string => typeof s === "string")
      : [];
  } catch {
    return [];
  }
}

function pushRecent(slug: string): void {
  try {
    const next = [slug, ...readRecent().filter((s) => s !== slug)].slice(0, 5);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // storage unavailable: no recents
  }
}

/** Is the product's page the one showing? */
function onProduct(slug: string): boolean {
  const { route } = resolveHash(window.location.hash);
  return route.kind === "product" && route.product === slug;
}

export function JumpPalette({
  open,
  onOpenChange,
  products,
  onActivate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  products: readonly LibraryProduct[];
  onActivate: () => void;
}): React.ReactElement {
  const [query, setQuery] = React.useState("");
  React.useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  /** A product was chosen: closing must not hand focus back to the opener (below). */
  const jumped = React.useRef(false);
  const found = products.filter((p) => matches(p, query));
  const top = query.trim() ? found[0] : undefined;
  const recent = query.trim()
    ? []
    : readRecent()
        .map((s) => products.find((p) => p.slug === s))
        .filter((p): p is LibraryProduct => Boolean(p));

  /*
   * Focus lands on the product's `h1` (FLOWS.md P-14, PORTAL.md §9.4), not on `body`: the
   * product page takes the request once its heading exists. Already on that product, the page
   * does not mount again, so the heading is focused here, after the palette has closed, without
   * scrolling away from the section a "Manage devices" jump scrolls to.
   *
   * Motion (MO-05): the palette exits through motion.css (its `animate-pk-in` content and
   * `animate-pk-overlay-in` scrim; MO-02) and the page swaps underneath it. The router starts no
   * View Transition while a dialog is on screen (one would lift the page above the scrim), and
   * the results never animate while typing: filtering only re-renders the list.
   */
  const go = (p: LibraryProduct, section?: "devices"): void => {
    pushRecent(p.slug);
    jumped.current = true;
    const here = onProduct(p.slug);
    if (!here) requestHeadingFocus(p.slug);
    onOpenChange(false);
    navigate(href.product(p.slug, section));
    if (here) focusPageHeading();
  };

  const item =
    "flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-md text-fg data-[selected=true]:bg-accent-subtle data-[selected=true]:text-fg-strong";
  const group =
    "[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-bold [&_[cmdk-group-heading]]:text-fg-muted";

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 animate-pk-overlay-in" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onCloseAutoFocus={(e) => {
            // After a jump, focus belongs to the product's heading, not the trigger.
            if (!jumped.current) return;
            jumped.current = false;
            e.preventDefault();
          }}
          className={cn(
            "fixed inset-0 z-50 flex flex-col overflow-hidden bg-surface-overlay text-fg shadow-elevation-3 animate-pk-in",
            "desk:inset-auto desk:left-1/2 desk:top-[12vh] desk:w-[calc(100vw-2rem)] desk:max-w-[40rem] desk:-translate-x-1/2 desk:rounded-xl desk:border desk:border-border",
          )}
        >
          <DialogPrimitive.Title className="sr-only">
            Jump to a product
          </DialogPrimitive.Title>
          <Command
            label="Jump to a product"
            shouldFilter={false}
            loop
            vimBindings={false}
          >
            <div className="flex items-center gap-3 border-b border-border px-4">
              <Search aria-hidden className="size-5 shrink-0 text-fg-muted" />
              <Command.Input
                value={query}
                onValueChange={setQuery}
                aria-label="Jump to a product"
                placeholder="Jump to a product or action"
                className="h-14 w-full bg-transparent text-base outline-hidden placeholder:text-fg-subtle focus-visible:ring-0 focus-visible:ring-offset-0"
              />
              <DialogPrimitive.Close className="shrink-0 rounded-md px-2 py-1 text-sm text-fg-muted hover:text-fg-strong desk:hidden">
                Cancel
              </DialogPrimitive.Close>
            </div>
            <Command.List
              label="Results"
              className="max-h-full overflow-y-auto p-2 desk:max-h-[min(60vh,28rem)]"
            >
              {query.trim() && found.length === 0 ? (
                <p className="px-3 py-6 text-center text-sm text-fg-muted">
                  Nothing in your library matches “{query.trim()}”.
                </p>
              ) : null}
              {found.length ? (
                <Command.Group heading="Products" className={group}>
                  {found.map((p) => (
                    <Command.Item
                      key={p.slug}
                      value={`p:${p.slug}`}
                      onSelect={() => go(p)}
                      className={item}
                    >
                      <ProductIcon
                        slug={p.slug}
                        name={p.name}
                        tint={p.presentation.tint}
                        src={p.presentation.iconUrl}
                        size={24}
                      />
                      <span className="min-w-0 flex-1 truncate">{p.name}</span>
                      <span className="shrink-0 text-xs text-fg-muted">
                        {p.status.label}
                      </span>
                    </Command.Item>
                  ))}
                </Command.Group>
              ) : null}
              <Command.Group heading="Actions" className={group}>
                {/* An open product's entry (PS-04) has no devices to manage. */}
                {top && top.kind !== "entry" ? (
                  <Command.Item
                    value={`devices:${top.slug}`}
                    onSelect={() => go(top, "devices")}
                    className={item}
                  >
                    <MonitorSmartphone
                      aria-hidden
                      className="size-4 text-fg-muted"
                    />
                    Manage devices for {top.name}
                  </Command.Item>
                ) : null}
                <Command.Item
                  value="activate"
                  onSelect={() => {
                    onOpenChange(false);
                    onActivate();
                  }}
                  className={item}
                >
                  <KeyRound aria-hidden className="size-4 text-accent-fg" />
                  Activate a license
                </Command.Item>
              </Command.Group>
              {recent.length ? (
                <Command.Group heading="Recent" className={group}>
                  {recent.map((p) => (
                    <Command.Item
                      key={p.slug}
                      value={`r:${p.slug}`}
                      onSelect={() => go(p)}
                      className={item}
                    >
                      <Clock aria-hidden className="size-4 text-fg-muted" />
                      {p.name}
                    </Command.Item>
                  ))}
                </Command.Group>
              ) : null}
            </Command.List>
          </Command>
          <LiveRegion
            message={
              open && query.trim()
                ? `${found.length} ${found.length === 1 ? "product" : "products"}`
                : ""
            }
          />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** The header trigger: "Jump to a product ⌘K" (an icon below 900 px). */
export function JumpTrigger({
  onOpen,
}: {
  onOpen: () => void;
}): React.ReactElement {
  const mac =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad/.test(navigator.userAgent);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="Jump to a product"
      aria-keyshortcuts={mac ? "Meta+K" : "Control+K"}
      className="inline-flex h-10 items-center gap-3 rounded-md border border-border bg-surface-raised px-3 text-sm text-fg-muted hover:text-fg-strong min-[900px]:w-64"
    >
      <Search aria-hidden className="size-4 shrink-0" />
      <span className="hidden flex-1 text-left min-[900px]:inline">
        Jump to a product
      </span>
      <Kbd keys={mac ? "⌘K" : "Ctrl K"} className="hidden min-[900px]:flex" />
    </button>
  );
}

/** The phone header's search icon. */
export function JumpIconButton({
  onOpen,
}: {
  onOpen: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="Jump to a product"
      className="inline-flex size-11 items-center justify-center rounded-full text-fg-strong hover:bg-hover"
    >
      <Search aria-hidden className="size-5" />
    </button>
  );
}
