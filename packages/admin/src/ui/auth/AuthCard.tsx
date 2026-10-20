import * as React from "react";
import { cn } from "../../lib/cn.js";
import { t } from "../../lib/copy.js";

/**
 * The one sign-in frame (SIGN-IN.md §3.1, PORTAL.md §5.2 `AuthCard`; UX-40 promoted the portal's
 * `LoginCard` here). It knows no app: the brand row (`brand`), the product icon of a context
 * header and every string arrive from the host, so the portal and the Worker's pages share it.
 *
 * The frame: the lockup above, the
 * 28.5 rem card (radius 22 px, elevation 3) with its optional persistent `header`, the step
 * `children` (one primary each) and the passthrough `footer`, on the plain page (the Locker look
 * has no star field, LK-06). Phones: the card goes edge to edge under a 56 px lockup row. No
 * "Polaris Key · key.plrs.im" line under the card.
 *
 * Steps replace each other in place (§3.18, S-23 tokens): when `stepKey` changes the body's
 * height morphs from the old size to the new one at `moderate` (the Web Animations API, which the
 * strict CSP allows), the new step enters `lg` (12 px) from the side of travel (`direction`) at
 * `base`, focus moves to its h1 and the polite live region announces it once. The header and
 * footer stay still. Under reduced motion (the OS setting or `data-motion="reduce"`) the brand's
 * durations are 0 ms, so every step swaps instantly with no fade (S-23 D3).
 */
export function AuthCard({
  brand,
  header,
  footer,
  stepKey,
  direction = "forward",
  loadingKey = "loading",
  focusKey = 0,
  children,
}: {
  /** The brand row: the lockup (portal: Polaris Locker). Decorative; the page names itself. */
  brand: React.ReactNode;
  header?: React.ReactNode;
  footer?: React.ReactNode;
  /** Changes with the step; the new step's h1 is focused. */
  stepKey: string;
  /** Which way the flow went: Back, Change and Use a different email enter from the start. */
  direction?: "forward" | "back";
  /** The page-load placeholder's step key; leaving it is not a step change. */
  loadingKey?: string;
  /**
   * Bump it when the control the person pressed is about to vanish into a reload (Try again):
   * the next h1 to appear takes focus and is announced, though no step changed.
   */
  focusKey?: number;
  children: React.ReactNode;
}): React.ReactElement {
  const bodyRef = React.useRef<HTMLDivElement>(null);
  const lastHeight = React.useRef<number | null>(null);
  const first = React.useRef(true);
  const [announce, setAnnounce] = React.useState("");
  // Whether this step arrived by a step change. The first step after page load (the skeleton
  // giving way to the methods) is not one: no slide, no focus move, no announcement.
  const arrival = React.useRef<{ key: string; moved: boolean } | null>(null);
  if (arrival.current === null)
    arrival.current = { key: stepKey, moved: false };
  else if (arrival.current.key !== stepKey)
    arrival.current = {
      key: stepKey,
      moved: arrival.current.key !== loadingKey,
    };
  const moved = arrival.current.moved;

  // Keep the body's last laid-out height, so a step change can morph from it.
  React.useEffect(() => {
    const el = bodyRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      lastHeight.current = el.offsetHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  React.useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    if (first.current) {
      first.current = false;
      lastHeight.current = el.offsetHeight;
      return;
    }
    const from = lastHeight.current;
    const to = el.offsetHeight;
    lastHeight.current = to;
    if (!moved) return;
    const ms = motionMs("--pk-duration-moderate");
    if (from !== null && from !== to && ms > 0 && el.animate) {
      el.animate([{ height: `${from}px` }, { height: `${to}px` }], {
        duration: ms,
        easing: cssVar("--pk-ease-standard") || "ease",
      });
    }
    const h1 = el.querySelector<HTMLElement>("h1");
    h1?.focus({ preventScroll: true });
    setAnnounce(h1?.textContent ?? "");
  }, [stepKey]);

  React.useEffect(() => {
    if (!focusKey) return;
    const h1 = bodyRef.current?.querySelector<HTMLElement>("h1");
    if (!h1) return;
    h1.focus({ preventScroll: true });
    setAnnounce(h1.textContent ?? "");
  }, [focusKey, stepKey]);

  return (
    <div className="relative flex min-h-dvh flex-col bg-surface-page text-fg">
      <div className="relative z-10 flex h-14 items-center justify-center border-b border-border sm:h-auto sm:border-0 sm:pb-4 sm:pt-[10vh]">
        {brand}
      </div>
      <main className="relative z-10 flex flex-1 flex-col items-center sm:px-4">
        <div className="w-full overflow-hidden bg-surface-raised sm:mb-6 sm:max-w-[28.5rem] sm:rounded-[1.375rem] sm:border sm:border-border sm:shadow-elevation-3">
          {header ? (
            <div className="border-b border-border">{header}</div>
          ) : null}
          <div ref={bodyRef} className="overflow-hidden">
            <div
              key={stepKey}
              data-step={stepKey}
              className={cn(
                "space-y-5 px-5 py-6 sm:px-7 sm:py-8",
                moved &&
                  (direction === "back"
                    ? "animate-pk-step-back"
                    : "animate-pk-step-forward"),
                "motion-reduce:animate-none",
              )}
            >
              {children}
            </div>
          </div>
          {footer ? (
            <div className="border-t border-border px-5 py-4 text-sm text-fg-muted sm:px-7">
              {footer}
            </div>
          ) : null}
        </div>
        <div aria-live="polite" data-step-announcer className="sr-only">
          {announce}
        </div>
      </main>
    </div>
  );
}

function cssVar(name: string): string {
  if (typeof window === "undefined" || !window.getComputedStyle) return "";
  return window
    .getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
}

/** A brand duration token in milliseconds (0 under reduced motion, where the tokens collapse). */
function motionMs(name: string): number {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return 0;
  const raw = cssVar(name);
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return 0;
  return raw.endsWith("ms") ? n : n * 1000;
}

/**
 * The card header, data only (§3.1, §5.2 `CardHeader`): today only the product-context variant,
 * "<Product> · <Developer>" over "Your license, downloads and devices".
 */
export function CardHeader({
  variant,
  icon,
  name,
  developer,
}: {
  variant: "context";
  /** The product's icon, drawn by the host (48 px). */
  icon: React.ReactNode;
  name: string;
  developer: string | null;
}): React.ReactElement {
  return (
    <div
      data-variant={variant}
      className="flex items-center gap-4 px-5 py-4 sm:px-7"
    >
      {icon}
      <div className="min-w-0">
        <p className="text-fg-strong">
          <span className="font-medium">{name}</span>
          {developer ? ` · ${developer}` : null}
        </p>
        <p className="text-sm text-fg-muted">
          {t("signin.header.contextLine")}
        </p>
      </div>
    </div>
  );
}
