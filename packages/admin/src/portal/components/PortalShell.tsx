import * as React from "react";
import { Compass, KeyRound, Library } from "lucide-react";
import { Button } from "../../ui/Button.js";
import { TOAST_BOTTOM_INSET_VAR } from "../../ui/toast.js";
import { cn } from "../../lib/cn.js";
import type { PortalAccount } from "../api.js";
import { useActivate } from "../activate.js";
import { href, type PortalRoute } from "../router.js";
import { AccountMenu } from "./AccountMenu.js";
import { Lockup } from "./Lockup.js";
import { t } from "../../lib/copy.js";

/**
 * The signed-in frame (PORTAL.md §3.2, §5.2 `PortalShell`):
 *
 * - **Header** (64 px; 56 on phones): the compact lockup (the link home), the Library nav with
 *   its count, a slot for the ⌘K trigger, the right-aligned **Activate license** action and the
 *   account menu.
 * - **Tablet header** (761–1179 px, PORTAL.md §8): the same row, compacted so the account menu
 *   never leaves the screen: the account chip is its avatar, the ⌘K trigger an icon, and below
 *   900 px the lockup drops to its phone size, the gaps to 24 px and the action reads
 *   **Activate** (its accessible name stays "Activate license"). From 1180 px the chip adds the
 *   given name; when the row is tight the ⌘K field gives way first (down to 176 px), and only then
 *   does the name truncate. ⌘K, Activate and the chip share one height: 40 px, 44 on a coarse
 *   pointer.
 * - **Phone bar** (≤ 760 px): Library, the Activate pill in the middle, and Discover.
 * - **Footer**, a skip link, one `banner`, `nav` ("Main"), `main` and `contentinfo`.
 *
 * Discover sits in the nav with its count of offers (a small violet count; a dot on the phone
 * bar) once `GET /api/library` carries `discoverCount` (G24, PX-W10) and the Discover page can
 * show those offers (`model/discover.ts`); otherwise Discover is hidden from the nav, as the
 * spec's fallback says.
 */
export function PortalShell({
  account,
  route,
  libraryCount,
  discoverCount = null,
  headerExtra,
  phoneHeaderExtra,
  children,
}: {
  account: PortalAccount;
  route: PortalRoute;
  /** Products in the library, once known. */
  libraryCount: number | null;
  /** Offers in Discover; `null` keeps Discover out of the nav (the Worker can't list them). */
  discoverCount?: number | null;
  /** The ⌘K trigger (PX-03), shown from 8 products. */
  headerExtra?: React.ReactNode;
  /** The phone header's search icon (PX-03). */
  phoneHeaderExtra?: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  const activate = useActivate();
  // The product pages live inside the Library (§3.2): its tab stays current there.
  const onLibrary = route.kind === "library" || route.kind === "product";
  // A storefront product page (PS-05) lives inside Discover: its tab stays current there.
  const onDiscover = route.kind === "discover" || route.kind === "storefront";
  const showDiscover = discoverCount !== null;
  const mainRef = React.useRef<HTMLElement>(null);
  usePhoneBarToastInset();

  return (
    // pk-portal-shell: the document's scroll padding clears the sticky header (styles.css).
    <div className="pk-portal-shell flex min-h-dvh flex-col bg-surface-page text-fg">
      {/* "#content", not "#/": the hash router never sees it (onClick), and axe recognises a skip
          link only by an in-page fragment (PX-20). */}
      <a
        href="#content"
        onClick={(e) => {
          e.preventDefault();
          mainRef.current?.focus();
        }}
        className="sr-only z-50 rounded-md bg-surface-overlay px-3 py-2 text-fg-strong focus:not-sr-only focus:fixed focus:left-4 focus:top-3"
      >
        Skip to content
      </a>
      {/* pk-vt-chrome: kept above a list transition's moving content (src/motion.css). */}
      <header className="pk-vt-chrome sticky top-0 z-30 border-b border-border bg-surface-page short:static">
        <div className="mx-auto flex h-14 w-full max-w-[82rem] items-center gap-4 px-4 desk:h-16 desk:gap-6 desk:px-8 mid:gap-8">
          <a
            href={href.library()}
            aria-label="Polaris Key: your library"
            className="flex shrink-0 items-center rounded-md"
          >
            <Lockup height={64} className="hidden mid:block" />
            <Lockup height={52} className="mid:hidden" />
          </a>
          <nav
            aria-label="Main"
            className="hidden h-full shrink-0 items-stretch gap-6 desk:flex mid:gap-8"
          >
            <NavLink
              href={href.library()}
              active={onLibrary}
              label="Library"
              count={libraryCount}
            />
            {showDiscover ? (
              <NavLink
                href={href.discover()}
                active={onDiscover}
                label="Discover"
                count={discoverCount}
                accentCount
              />
            ) : null}
          </nav>
          {/* min-w-0: when the row is tight from 1180 px, the ⌘K field gives way first (its
              wrapper shrinks far faster, down to 11rem), then the account chip's name. */}
          <div className="ml-auto flex min-w-0 items-center gap-3">
            {headerExtra ? (
              <div className="hidden shrink-0 desk:flex wide:min-w-44 wide:shrink-[999]">
                {headerExtra}
              </div>
            ) : null}
            {phoneHeaderExtra ? (
              <div className="shrink-0 desk:hidden">{phoneHeaderExtra}</div>
            ) : null}
            <Button
              variant="action"
              className="hidden h-10 shrink-0 px-3 desk:inline-flex mid:px-4 pointer-coarse:h-11"
              iconStart={<KeyRound aria-hidden />}
              aria-label={t("activate.submit")}
              onClick={() => activate.open()}
            >
              <span className="mid:hidden">
                {t("core.gate.needs-activation.title")}
              </span>
              <span className="hidden mid:inline">{t("activate.submit")}</span>
            </Button>
            <AccountMenu account={account} />
          </div>
        </div>
      </header>
      <main
        id="content"
        ref={mainRef}
        tabIndex={-1}
        // A short screen (§8) keeps the space above the page's title small.
        className="mx-auto w-full max-w-[82rem] flex-1 px-4 pb-28 pt-6 outline-none desk:px-8 desk:pb-16 desk:pt-10 short:pt-4"
      >
        {children}
      </main>
      <footer className="border-t border-border pb-24 desk:pb-0">
        <div className="mx-auto flex w-full max-w-[82rem] flex-wrap items-center justify-between gap-2 px-4 py-6 text-sm text-fg-muted desk:px-8">
          <span>Polaris Key · key.plrs.im</span>
        </div>
      </footer>
      <nav
        aria-label="Phone"
        className="pk-vt-chrome fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface-page pb-[env(safe-area-inset-bottom)] desk:hidden"
      >
        <div className="grid h-[3.25rem] grid-cols-3 items-center px-2">
          <a
            href={href.library()}
            aria-current={onLibrary ? "page" : undefined}
            className={cn(
              "flex h-full flex-col items-center justify-center gap-0.5 text-xs",
              onLibrary ? "font-medium text-fg-strong" : "text-fg-muted",
            )}
          >
            <Library aria-hidden className="size-5" />
            Library
          </a>
          <div className="flex justify-center">
            <button
              type="button"
              onClick={() => activate.open()}
              className="inline-flex h-10 items-center gap-2 rounded-full border border-border-strong bg-surface-raised px-4 text-sm font-medium text-fg-strong"
            >
              <KeyRound aria-hidden className="size-4 text-accent-fg" />
              {t("core.gate.needs-activation.title")}
            </button>
          </div>
          {showDiscover ? (
            <a
              href={href.discover()}
              aria-current={onDiscover ? "page" : undefined}
              className={cn(
                "flex h-full flex-col items-center justify-center gap-0.5 text-xs",
                onDiscover ? "font-medium text-fg-strong" : "text-fg-muted",
              )}
            >
              <span className="relative">
                <Compass aria-hidden className="size-5" />
                {discoverCount ? (
                  <span
                    aria-hidden
                    className="absolute -right-1 -top-0.5 size-2 rounded-full bg-accent"
                  />
                ) : null}
              </span>
              Discover
              {discoverCount ? (
                <span className="sr-only">
                  , {discoverCount} {discoverCount === 1 ? "offer" : "offers"}
                </span>
              ) : null}
            </a>
          ) : (
            <span />
          )}
        </div>
      </nav>
    </div>
  );
}

/**
 * Toasts on phones sit at the bottom (EXPERIENCE.md §7, FLOWS.md P-7), above the phone bar while
 * it shows (below `desk`): its 52 px row, its hairline, the safe area and a 12 px gap.
 */
function usePhoneBarToastInset(): void {
  React.useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const root = document.documentElement;
    const barShows = window.matchMedia("(max-width: 47.5rem)");
    const apply = (): void => {
      if (barShows.matches)
        root.style.setProperty(
          TOAST_BOTTOM_INSET_VAR,
          "calc(3.25rem + 1px + env(safe-area-inset-bottom) + 0.75rem)",
        );
      else root.style.removeProperty(TOAST_BOTTOM_INSET_VAR);
    };
    apply();
    barShows.addEventListener("change", apply);
    return () => {
      barShows.removeEventListener("change", apply);
      root.style.removeProperty(TOAST_BOTTOM_INSET_VAR);
    };
  }, []);
}

function NavLink({
  href: to,
  active,
  label,
  count,
  accentCount = false,
}: {
  href: string;
  active: boolean;
  label: string;
  count: number | null;
  /** Discover's count of offers: small, violet, on a subtle plate (§4.16). */
  accentCount?: boolean;
}): React.ReactElement {
  return (
    <a
      href={to}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative inline-flex items-center gap-2.5 px-1 text-md",
        active
          ? "font-medium text-fg-strong after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full after:bg-accent"
          : "text-fg-muted hover:text-fg-strong",
      )}
    >
      {label}
      {count ? (
        <span
          className={cn(
            "inline-flex min-w-6 items-center justify-center rounded-full px-2 py-0.5 text-xs font-normal tabular-nums",
            // Discover's count of offers is always the small violet count (§4.16).
            active || accentCount
              ? "bg-accent-subtle text-accent-fg"
              : "bg-surface-raised text-fg-muted ring-1 ring-inset ring-border",
          )}
        >
          {count}
        </span>
      ) : null}
    </a>
  );
}
