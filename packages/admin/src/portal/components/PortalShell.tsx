import * as React from "react";
import { useLargeTextFlag } from "../../lib/useLargeTextFlag.js";
import { LayoutGrid, Sparkles, TriangleAlert } from "lucide-react";
import { TOAST_BOTTOM_INSET_VAR } from "../../ui/toast.js";
import { cn } from "../../lib/cn.js";
import type { PortalAccount } from "../api.js";
import { href, type PortalRoute } from "../router.js";
import { AccountMenu } from "./AccountMenu.js";
import { HeaderBrand } from "./Lockup.js";
import { MissingLicense } from "./MissingLicense.js";
import { PortalErrorBoundary } from "./PortalErrorBoundary.js";
import { t } from "../../lib/copy.js";
import { formatDay } from "../date.js";

/** The phone bar's current tab: strong ink and the 3 px coral selected marker (PORTAL.md §3, D9a). */
const TAB_MARK =
  "font-medium text-fg-strong before:absolute before:inset-x-0 before:top-0 before:h-[3px] before:bg-[var(--pk-locker-accent)]";

/**
 * The signed-in frame (PORTAL.md §3.2, §5.2 `PortalShell`):
 *
 * - **Header** (64 px; 56 on phones): the trimmed Locker lockup (the link home; the mark alone
 *   under 24 rem), the Library nav with its count, a slot for the ⌘K trigger and the account
 *   menu. Activate a license, Help and Privacy live in the account menu (PX-35); the Library's
 *   key tile and the palette also reach Activate.
 * - **Tablet header** (761–1179 px, PORTAL.md §8): the same row, compacted so the account menu
 *   never leaves the screen: the account chip is its avatar, the ⌘K trigger an icon, and below
 *   900 px the lockup drops to its phone size and the gaps to 24 px. From 1180 px the chip adds
 *   the given name; when the row is tight the ⌘K field gives way first (down to 176 px), and only
 *   then does the name truncate. ⌘K and the chip share one height: 40 px, 44 on a coarse pointer.
 * - **Phone bar** (≤ 760 px): Library and Discover.
 * - No footer: a skip link, one `banner`, `nav` ("Main") and `main`. The Library ends in its own
 *   sticky "Missing a license?" strip (`MissingLicense`).
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
  // The product pages live inside the Library (§3.2): its tab stays current there.
  const onLibrary = route.kind === "library" || route.kind === "product";
  // A storefront product page (PS-05) lives inside Discover: its tab stays current there.
  const onDiscover = route.kind === "discover" || route.kind === "storefront";
  // Reserved while the Library loads (libraryCount null), so the tab doesn't pop in; it leaves only
  // when the Library answered without Discover.
  const showDiscover = discoverCount !== null || libraryCount === null;
  const mainRef = React.useRef<HTMLElement>(null);
  usePhoneBarToastInset();
  useLargeTextFlag();

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
        className="sr-only z-50 rounded-md bg-surface-overlay px-3 py-2 text-fg-strong focus:not-sr-only focus:fixed focus:start-4 focus:top-3"
      >
        {t("locker.shell.skip")}
      </a>
      {/* pk-vt-chrome: kept above a list transition's moving content (src/motion.css). */}
      <header className="@container pk-vt-chrome sticky top-0 z-30 border-b border-border bg-surface-page short:static tight:max-desk:static">
        <div className="mx-auto flex h-[calc(3.5rem-1px)] w-full max-w-[82rem] items-center gap-4 px-4 @max-[21rem]:gap-2 @max-[21rem]:px-3 @max-[16rem]:gap-2 @max-[16rem]:px-2 desk:h-[calc(4rem-1px)] desk:gap-6 desk:px-6 mid:gap-8">
          <a
            href={href.library()}
            aria-label={t("locker.shell.home")}
            className="flex min-h-6 shrink-0 items-center rounded-md pointer-coarse:min-h-11"
          >
            <HeaderBrand container />
          </a>
          <nav
            aria-label={t("locker.shell.main")}
            className="hidden h-full shrink-0 items-stretch gap-6 desk:flex mid:gap-8"
          >
            <NavLink
              href={href.library()}
              active={onLibrary}
              label={t("locker.library.title")}
              count={libraryCount}
            />
            {showDiscover ? (
              <NavLink
                href={href.discover()}
                active={onDiscover}
                label={t("locker.discover.title")}
                count={discoverCount}
                accentCount
              />
            ) : null}
          </nav>
          {/* min-w-0: when the row is tight from 1180 px, the ⌘K field gives way first (its
              wrapper shrinks far faster, down to 11rem), then the account chip's name. */}
          <div className="ms-auto flex min-w-0 items-center gap-3 @max-[21rem]:gap-1 @max-[16rem]:gap-1">
            {headerExtra ? (
              <div className="hidden shrink-0 desk:flex wide:min-w-44 wide:shrink-[999]">
                {headerExtra}
              </div>
            ) : null}
            {phoneHeaderExtra ? (
              <div className="shrink-0 desk:hidden">{phoneHeaderExtra}</div>
            ) : null}
            <AccountMenu account={account} />
          </div>
        </div>
      </header>
      {/* A scheduled account deletion (I-11): said on every page, with the way back. */}
      {account.deletion ? (
        <div
          role="status"
          className="border-b border-warning-border bg-warning-subtle"
        >
          <p className="mx-auto flex w-full max-w-[82rem] flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm text-fg desk:px-6">
            <TriangleAlert aria-hidden className="size-4 shrink-0" />
            <span>
              {t("locker.delete.banner", {
                date: formatDay(account.deletion.dueAt),
              })}
            </span>
            <a
              href={href.account("data")}
              className="inline-flex min-h-6 items-center font-medium text-fg-strong underline underline-offset-2"
            >
              {t("locker.delete.cancel")}
            </a>
          </p>
        </div>
      ) : null}
      <main
        id="content"
        ref={mainRef}
        tabIndex={-1}
        // A short screen (§8) keeps the space above the page's title small.
        className={cn(
          "mx-auto w-full max-w-[82rem] flex-1 px-4 pt-6 outline-none desk:px-6 sm:pt-10 short:pt-4",
          // Room for the phone bar; the Library's sticky strip ends the page, so it adds none.
          route.kind === "library"
            ? "pb-[calc(3.25rem+1px+env(safe-area-inset-bottom)+1.6875rem)] desk:pb-8"
            : "pb-[calc(3.25rem+1px+env(safe-area-inset-bottom)+1.6875rem)] desk:pb-12",
        )}
      >
        <PortalErrorBoundary resetKey={window.location.hash}>
          {children}
        </PortalErrorBoundary>
      </main>
      {/* The Library's sticky footer, static help every state of it has (PX-35). */}
      {route.kind === "library" ? (
        <MissingLicense
          // The key tile (2-7 products) and the empty state (none) have Activate of their own.
          hideActivate={
            libraryCount !== null && libraryCount !== 1 && libraryCount < 8
          }
        />
      ) : null}
      <nav
        aria-label={t("locker.shell.phone")}
        className="pk-vt-chrome fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface-page pb-[env(safe-area-inset-bottom)] desk:hidden"
      >
        <div className="grid h-[3.25rem] grid-cols-2 items-center px-2">
          <a
            href={href.library()}
            aria-current={onLibrary ? "page" : undefined}
            className={cn(
              "relative flex h-full flex-col items-center justify-center gap-0.5 text-xs",
              onLibrary ? TAB_MARK : "text-fg-muted",
            )}
          >
            <LayoutGrid aria-hidden className="size-5" />
            {t("locker.library.title")}
          </a>
          {showDiscover ? (
            <a
              href={href.discover()}
              aria-current={onDiscover ? "page" : undefined}
              className={cn(
                "relative flex h-full flex-col items-center justify-center gap-0.5 text-xs",
                onDiscover ? TAB_MARK : "text-fg-muted",
              )}
            >
              <span className="relative">
                <Sparkles aria-hidden className="size-5" />
                {discoverCount ? (
                  <span
                    aria-hidden
                    className="absolute -end-1 -top-0.5 size-2 rounded-full bg-accent"
                  />
                ) : null}
              </span>
              {t("locker.discover.title")}
              {discoverCount ? (
                <span className="sr-only">
                  {t("locker.shell.toAdd", { count: discoverCount })}
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
          "calc(3.25rem + 1px + env(safe-area-inset-bottom) + var(--pk-strip-h, 0px) + 0.75rem)",
        );
      else
        // No bar: the Library's sticky strip is all a bottom toast has to clear.
        root.style.setProperty(
          TOAST_BOTTOM_INSET_VAR,
          "calc(var(--pk-strip-h, 0px) + 0.75rem)",
        );
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
        "relative inline-flex items-center gap-2 px-1 text-md",
        active
          ? "font-medium text-fg-strong after:absolute after:inset-x-0 after:-bottom-px after:rounded-full after:h-[3px] after:bg-[var(--pk-locker-accent)]"
          : "text-fg-muted hover:text-fg-strong",
      )}
    >
      {label}
      {count ? (
        <span
          className={cn(
            "inline-flex min-w-6 items-center justify-center rounded-full px-2 py-0.5 text-xs font-normal tabular-nums",
            // Discover's count of offers is always the small violet count (§4.16).
            accentCount
              ? "bg-hover font-medium text-fg-strong ring-1 ring-inset ring-border"
              : active
                ? "bg-accent-subtle text-accent-fg"
                : "bg-surface-raised text-fg-muted ring-1 ring-inset ring-border",
          )}
        >
          {count}
          {accentCount ? <span className="sr-only"> to add</span> : null}
        </span>
      ) : null}
    </a>
  );
}
