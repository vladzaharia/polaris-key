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
import { t } from "../../lib/copy.js";

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
  // At the 320 px floor the full placeholder is cut off; it reads "Jump to…" there.
  const [narrow, setNarrow] = React.useState(false);
  React.useEffect(() => {
    if (!open) setQuery("");
    else
      setNarrow(
        typeof window.matchMedia === "function" &&
          window.matchMedia("(max-width: 24rem)").matches,
      );
  }, [open]);

  /** A product was chosen: closing must not hand focus back to the opener (below). */
  const jumped = React.useRef(false);
  /*
   * Where focus was when the palette opened (the header trigger, the phone search icon, or a
   * tile's link under ⌘K). The palette has no Radix trigger, so without this, closing it without
   * a jump would drop focus to `body`; it goes back to the opener instead (§9.4). Read during
   * render, before Radix moves focus in, as `useOverlayFocus` does.
   */
  const opener = React.useRef<HTMLElement | null>(null);
  const wasOpen = React.useRef(false);
  if (open && !wasOpen.current && typeof document !== "undefined") {
    const active = document.activeElement;
    opener.current =
      active instanceof HTMLElement && active !== document.body ? active : null;
  }
  wasOpen.current = open;
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
    "[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-fg-muted";

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-(--polaris-key-page-dark)/60 animate-pk-overlay-in" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            // After a jump, focus belongs to the product's heading, not the opener.
            if (jumped.current) {
              jumped.current = false;
              return;
            }
            const back = opener.current;
            opener.current = null;
            (back?.isConnected ? back : visibleTrigger())?.focus();
          }}
          className={cn(
            "fixed inset-0 z-50 flex flex-col overflow-hidden bg-surface-overlay text-fg shadow-elevation-3 animate-pk-in",
            "desk:inset-auto desk:start-1/2 desk:top-[12vh] desk:w-[calc(100%-2rem)] desk:max-w-[40rem] desk:-translate-x-1/2 desk:rtl:translate-x-1/2 desk:rounded-xl desk:border desk:border-border",
          )}
        >
          <DialogPrimitive.Title className="sr-only">
            {t("locker.jump.title")}
          </DialogPrimitive.Title>
          <Command
            label={t("locker.jump.title")}
            shouldFilter={false}
            loop
            vimBindings={false}
          >
            <div className="flex items-center gap-3 border-b border-border px-4">
              <Search aria-hidden className="size-5 shrink-0 text-fg-muted" />
              <Command.Input
                value={query}
                onValueChange={setQuery}
                aria-label={t("locker.jump.title")}
                placeholder={
                  narrow ? t("locker.jump.short") : t("locker.jump.placeholder")
                }
                className="h-14 w-full bg-transparent text-base outline-hidden placeholder:text-fg-subtle"
              />
              <DialogPrimitive.Close className="shrink-0 rounded-md px-2 py-1 text-sm text-fg-muted hover:text-fg-strong desk:hidden">
                {t("signin.cancel")}
              </DialogPrimitive.Close>
            </div>
            <Command.List
              label={t("locker.jump.results")}
              className="max-h-full overflow-y-auto p-2 desk:max-h-[min(60vh,28rem)]"
            >
              {query.trim() && found.length === 0 ? (
                <p className="px-3 py-6 text-center text-sm text-fg-muted">
                  {t("locker.library.noMatchQuery", { name: query.trim() })}
                </p>
              ) : null}
              {found.length ? (
                <Command.Group
                  heading={t("locker.jump.products")}
                  className={group}
                >
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
                      <span dir="auto" className="min-w-0 flex-1 truncate">
                        {p.name}
                      </span>
                      <span className="shrink-0 text-xs text-fg-muted">
                        {p.status.label}
                      </span>
                    </Command.Item>
                  ))}
                </Command.Group>
              ) : null}
              <Command.Group
                heading={t("locker.jump.actions")}
                className={group}
              >
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
                    {t("locker.jump.devices", { product: top.name })}
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
                  {t("common.activateLicense")}
                </Command.Item>
              </Command.Group>
              {recent.length ? (
                <Command.Group
                  heading={t("locker.jump.recent")}
                  className={group}
                >
                  {recent.map((p) => (
                    <Command.Item
                      key={p.slug}
                      value={`r:${p.slug}`}
                      onSelect={() => go(p)}
                      className={item}
                    >
                      <Clock aria-hidden className="size-4 text-fg-muted" />
                      <span dir="auto">{p.name}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              ) : null}
            </Command.List>
          </Command>
          <LiveRegion
            message={
              open && query.trim()
                ? t("locker.jump.count", { count: found.length })
                : ""
            }
          />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** The header trigger or the phone search icon, whichever this width shows. */
function visibleTrigger(): HTMLElement | null {
  return (
    [...document.querySelectorAll<HTMLElement>("[data-jump-trigger]")].find(
      (el) => el.checkVisibility?.() ?? el.offsetParent !== null,
    ) ?? null
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
      data-jump-trigger=""
      aria-label={t("locker.jump.title")}
      className="inline-flex size-[44px] items-center justify-center rounded-full text-fg-strong hover:bg-hover"
    >
      <Search aria-hidden className="size-5" />
    </button>
  );
}
