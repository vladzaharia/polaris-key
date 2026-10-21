import * as React from "react";
import { cn } from "../../lib/cn.js";
import { Globe, Monitor, Tv } from "lucide-react";
import { t, tParts } from "../../lib/copy.js";

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
        <div
          data-passport={header ? "" : undefined}
          className={cn(
            "w-full overflow-hidden bg-surface-raised max-sm:flex-1 sm:mb-6 sm:max-w-[28.5rem] sm:rounded-[1.375rem] sm:border sm:border-border sm:shadow-elevation-3",
            // The passport: the header becomes a 17.5 rem start pane beside the form pane.
            header &&
              "passport:grid passport:max-w-[46rem] passport:grid-cols-[17.5rem_minmax(0,1fr)] passport:grid-rows-[1fr_auto]",
          )}
        >
          {header ? (
            <div
              data-pane="passport"
              className="border-b border-border passport:row-span-2 passport:border-b-0 passport:border-r passport:bg-surface-sunken"
            >
              {header}
            </div>
          ) : null}
          <div
            ref={bodyRef}
            className={cn(
              "overflow-hidden",
              header && "passport:col-start-2 passport:row-start-1",
            )}
          >
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
            <div
              className={cn(
                "border-t border-border px-5 py-4 text-sm text-fg-muted sm:px-7",
                header && "passport:col-start-2 passport:row-start-2",
              )}
            >
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

/** `@custom-variant passport` in styles.css, for the art the layout would otherwise hide. */
export const PASSPORT_QUERY = "(min-width: 60rem) and (min-aspect-ratio: 6/5)";

/** Whether the window is landscape enough for the passport (reactive; false without matchMedia). */
export function usePassport(): boolean {
  const [on, setOn] = React.useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia?.(PASSPORT_QUERY).matches === true,
  );
  React.useEffect(() => {
    const mq = window.matchMedia?.(PASSPORT_QUERY);
    if (!mq) return;
    const sync = () => setOn(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return on;
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
 * The card header, data only (§3.1, §5.2 `CardHeader`). Product context: "<Product> · <Developer>"
 * over "Your license, downloads and devices". App request (PX-14a): a 56 px icon, "<App> wants
 * you to sign in" with the name semibold, the developer, then where (a globe and the registered
 * origin, or a device glyph and "on <device>"); the `device` variant adds the code panel. Every
 * string is server data or the catalog's; the caller never passes a query value.
 */
export type CardHeaderProps =
  | {
      variant: "context";
      /** The product's icon, drawn by the host (48 px in the strip, 56 px in the pane). */
      icon: React.ReactNode;
      /** The product's art for the landscape pane (PX-33); drawn only there. */
      art?: string | null;
      name: string;
      developer: string | null;
      /** The key on-ramp of an app's request keeps the device line (§3.1). */
      where?: { glyph: "globe" | "device" | "tv"; text: string } | null;
    }
  | {
      variant: "app" | "device";
      /** The app's icon (56 px), or null for the neutral frame. */
      icon: React.ReactNode;
      /** The product's art for the landscape pane (PX-33); drawn only there. */
      art?: string | null;
      name: string;
      developer: string | null;
      where: { glyph: "globe" | "device" | "tv"; text: string } | null;
      /** The device-code panel's code (the `device` variant). */
      code?: string | null;
    };

const WHERE_GLYPH = { globe: Globe, device: Monitor, tv: Tv } as const;

/**
 * The pane's art (SIGN-IN.md "the product passport"): a decorative 16:10 `<img>`, cover-fit, at
 * most 40 % of the pane. Mounted only in the landscape layout, so a stacked card never fetches
 * it. No art: nothing, and never a generated fill.
 */
function PaneArt({ src }: { src?: string | null }): React.ReactElement | null {
  const on = usePassport();
  if (!src || !on) return null;
  return (
    <img
      data-pane-art
      src={src}
      alt=""
      className="aspect-[16/10] max-h-[40%] w-full rounded-lg object-cover"
    />
  );
}

/** The header's shared pane layout: the strip's row becomes a column top-aligned with the h1. */
const PANE = "passport:flex passport:flex-col passport:gap-4 passport:p-6";

export function CardHeader(props: CardHeaderProps): React.ReactElement {
  if (props.variant === "context") {
    const { variant, icon, name, developer, where, art } = props;
    const WhereGlyph = where ? WHERE_GLYPH[where.glyph] : null;
    return (
      <div
        data-header={variant}
        className={cn(
          "flex items-center gap-4 px-5 py-4 sm:px-7",
          PANE,
          "passport:items-start passport:px-6 passport:py-8",
        )}
      >
        <PaneArt src={art} />
        {icon}
        <div className="min-w-0">
          <p className="text-fg-strong">
            <span className="font-medium">{name}</span>
            {developer ? ` · ${developer}` : null}
          </p>
          <p className="text-sm text-fg-muted">
            {t("signin.header.contextLine")}
          </p>
          {WhereGlyph && where ? (
            <p className="flex items-center gap-1.5 text-sm text-fg-muted">
              <WhereGlyph aria-hidden className="size-4 shrink-0" />
              <span className="min-w-0 [overflow-wrap:anywhere]">
                {where.text}
              </span>
            </p>
          ) : null}
        </div>
      </div>
    );
  }
  const { variant, icon, name, developer, where, code, art } = props;
  const Glyph = where ? WHERE_GLYPH[where.glyph] : null;
  return (
    <div
      data-header={variant}
      className="space-y-3 px-5 py-4 sm:px-7 passport:space-y-4 passport:px-6 passport:py-8"
    >
      <PaneArt src={art} />
      <div className="flex items-center gap-4 passport:flex-col passport:items-start">
        {icon}
        <div className="min-w-0">
          <p className="text-lg/6 text-fg-strong [overflow-wrap:anywhere] passport:text-balance">
            {tParts("signin.header.app", ["app"], {}).map((part, i) =>
              typeof part === "string" ? (
                part
              ) : (
                <strong key={i} className="font-semibold">
                  {name}
                </strong>
              ),
            )}
          </p>
          {developer ? (
            <p className="text-sm text-fg-muted [overflow-wrap:anywhere]">
              {developer}
            </p>
          ) : null}
          {Glyph && where ? (
            <p className="flex items-center gap-1.5 text-sm text-fg-muted">
              <Glyph aria-hidden className="size-4 shrink-0" />
              <span className="min-w-0 [overflow-wrap:anywhere]">
                {where.text}
              </span>
            </p>
          ) : null}
        </div>
      </div>
      {code ? (
        <p
          data-code-panel
          className="rounded-md bg-surface-sunken px-4 py-3 text-sm text-fg-muted passport:border passport:border-border passport:bg-surface-raised"
        >
          {tParts("signin.header.codePanel", ["code"], {}).map((part, i) =>
            typeof part === "string" ? (
              part
            ) : (
              <span
                key={i}
                className="font-mono text-base font-semibold tracking-wider text-fg-strong"
              >
                {code}
              </span>
            ),
          )}
        </p>
      ) : null}
    </div>
  );
}
