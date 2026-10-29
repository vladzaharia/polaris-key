import * as React from "react";
import { cn } from "../../lib/cn.js";
import { Globe, Monitor, Smartphone, Tv } from "lucide-react";
import { t, tParts } from "../../lib/copy.js";

/**
 * Moves focus to a step's h1, except where the step marks the field its next action is typing in
 * (`data-step-focus`, the code step: SIGN-IN.md §3.14). That field takes focus, so the OS
 * one-time-code suggestion shows at once, and is described by the h1, which names the step.
 */
function focusStep(body: HTMLElement, h1: HTMLElement | null): void {
  const field = body.querySelector<HTMLElement>("[data-step-focus]");
  if (field && h1) {
    h1.id ||= "ac-step-title";
    const ids = (field.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .filter(Boolean);
    if (!ids.includes(h1.id))
      field.setAttribute("aria-describedby", [h1.id, ...ids].join(" "));
    field.focus({ preventScroll: true });
    return;
  }
  h1?.focus({ preventScroll: true });
}

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
 * `base`, focus moves to its h1 (the code step: its code field, `data-step-focus`) and the polite live region announces it once. The header and
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
  receipt = false,
  after,
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
  /** The footer is the app's trust receipt: in the passport it sits at the start pane's foot. */
  receipt?: boolean;
  /** Under the card, outside it (the app card's Help · Privacy, next to its receipt footer). */
  after?: React.ReactNode;
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
    focusStep(el, h1);
    setAnnounce(h1?.textContent ?? "");
  }, [stepKey]);

  React.useEffect(() => {
    if (!focusKey) return;
    const h1 = bodyRef.current?.querySelector<HTMLElement>("h1");
    if (!h1) return;
    focusStep(bodyRef.current!, h1);
    setAnnounce(h1.textContent ?? "");
  }, [focusKey, stepKey]);

  return (
    <div className="relative flex min-h-dvh flex-col bg-surface-page text-fg">
      <div className="relative z-10 flex h-14 items-center justify-center border-b border-border sm:h-auto sm:border-0 sm:pb-4 sm:pt-24 short:pt-10">
        {brand}
      </div>
      <main className="@container relative z-10 flex flex-1 flex-col items-center sm:px-4">
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
              className="border-b border-border passport:col-start-1 passport:row-start-1 passport:border-b-0 passport:border-e passport:bg-surface-sunken"
            >
              {header}
            </div>
          ) : null}
          <div
            ref={bodyRef}
            className={cn(
              "overflow-hidden",
              header &&
                (receipt
                  ? "passport:col-start-2 passport:row-span-2 passport:row-start-1"
                  : "passport:col-start-2 passport:row-start-1"),
            )}
          >
            <div
              key={stepKey}
              data-step={stepKey}
              className={cn(
                "space-y-5 px-5 py-6 sm:px-6 sm:py-8",
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
                "border-t border-border px-5 py-4 text-sm text-fg-muted sm:px-6",
                // The trust receipt anchors at the pane's foot (the pane never ends in a void).
                header &&
                  (receipt
                    ? "passport:col-start-1 passport:row-start-2 passport:border-e passport:border-t-0 passport:bg-surface-sunken passport:px-6"
                    : "passport:col-start-2 passport:row-start-2"),
              )}
            >
              {footer}
            </div>
          ) : null}
        </div>
        {after ? (
          <div className="mb-6 text-sm text-fg-muted max-sm:px-5 max-sm:pb-2">
            {after}
          </div>
        ) : null}
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
      where?: {
        glyph: "globe" | "device" | "phone" | "tv";
        text: string;
      } | null;
    }
  | {
      variant: "app" | "device";
      /** The app's icon (56 px), or null for the neutral frame. */
      icon: React.ReactNode;
      /** The product's art for the landscape pane (PX-33); drawn only there. */
      art?: string | null;
      name: string;
      developer: string | null;
      where: {
        glyph: "globe" | "device" | "phone" | "tv";
        text: string;
      } | null;
      /** The device-code panel's code (the `device` variant). */
      code?: string | null;
      /** `purpose: "attach"`: the headline reads "Add <App> to your account". */
      attach?: boolean;
    };

const WHERE_GLYPH = {
  globe: Globe,
  device: Monitor,
  phone: Smartphone,
  tv: Tv,
} as const;

/**
 * The pane's art (SIGN-IN.md "the product passport"): a decorative 16:10 `<img>`, cover-fit, edge
 * to edge at the top of the pane, at most 40 % of it. Hidden (and, being lazy, never fetched)
 * outside the passport layout. No art: nothing, and never a generated fill.
 */
function PaneArt({ src }: { src?: string | null }): React.ReactElement | null {
  if (!src) return null;
  return (
    <img
      data-pane-art
      src={src}
      alt=""
      loading="lazy"
      className="hidden aspect-[16/10] w-full object-cover passport:block passport:max-h-[min(40%,10rem)] passport:shrink-0"
    />
  );
}

/**
 * The strip's rows become the pane's column (`passport:contents`): art edge to edge, the icon
 * overlapping the art's lower edge (or at the top with no art), name and developer, then the
 * where-line right under the developer (B-070: it used to sink to the foot, under a void), the
 * art capped at 10 rem so the pane's text starts high.
 */
function Icon({
  children,
  art,
}: {
  children: React.ReactNode;
  art: boolean;
}): React.ReactElement {
  return (
    <div
      className={cn(
        "shrink-0 passport:ms-6 passport:w-fit passport:rounded-[14px]",
        art
          ? "passport:-mt-6 passport:ring-4 passport:ring-surface-sunken"
          : "passport:mt-0",
      )}
    >
      {children}
    </div>
  );
}

const WHERE =
  "flex items-start gap-1.5 text-sm text-fg-muted passport:px-6 passport:pt-1";
const PANE_TEXT = "passport:px-6";

function Where({
  where,
  centered = false,
}: {
  where:
    | { glyph: "globe" | "device" | "phone" | "tv"; text: string }
    | null
    | undefined;
  /** No art: the pane centres its identity block. */
  centered?: boolean;
}): React.ReactElement | null {
  if (!where) return null;
  const Glyph = WHERE_GLYPH[where.glyph];
  return (
    <p className={cn(WHERE, centered && "passport:justify-center")}>
      <Glyph aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 [overflow-wrap:anywhere]">{where.text}</span>
    </p>
  );
}

/** The header's placeholder while an app's request loads: the card is the same width from the first paint. */
export function HeaderSkeleton(): React.ReactElement {
  return (
    <div aria-hidden data-header="loading" className={OUTER}>
      <div className="flex items-center gap-4 px-5 py-4 sm:px-6 passport:contents">
        <Icon art={false}>
          <div className="size-14 rounded-[14px] bg-hover" />
        </Icon>
        <div className="min-w-0 flex-1 space-y-2 passport:contents">
          <div className="h-5 w-2/3 rounded bg-hover passport:mx-6 passport:mt-4 passport:w-auto" />
          <div className="h-4 w-1/3 rounded bg-hover passport:mx-6 passport:w-1/2" />
        </div>
      </div>
    </div>
  );
}

const OUTER = "passport:flex passport:h-full passport:flex-col";
/**
 * Without art the identity block sits in the middle of the pane, so it never has a void under it
 * (M4: icon, request, who and where, between the top and the receipt), centred, the icon large:
 * the one no-art rule, as the Worker's pages draw it (`ac-noart`).
 */
const OUTER_NO_ART = `${OUTER} passport:items-center passport:justify-center passport:py-6 passport:text-center`;

export function CardHeader(props: CardHeaderProps): React.ReactElement {
  const hasArt = Boolean(props.art);
  if (props.variant === "context") {
    const { variant, icon, name, developer, where, art } = props;
    return (
      <div data-header={variant} className={hasArt ? OUTER : OUTER_NO_ART}>
        <PaneArt src={art} />
        <div className="flex items-center gap-4 px-5 py-4 sm:px-6 passport:contents">
          <Icon art={hasArt}>{icon}</Icon>
          <div className="min-w-0 passport:contents">
            <p
              className={cn(
                "text-fg-strong passport:pt-4 passport:text-lg/6",
                PANE_TEXT,
              )}
            >
              <span className="font-medium">{name}</span>
              {developer ? ` · ${developer}` : null}
            </p>
            {where ? null : (
              <p className={cn("text-sm text-fg-muted", PANE_TEXT)}>
                {t("signin.header.contextLine")}
              </p>
            )}
            <Where where={where} centered={!hasArt} />
          </div>
        </div>
      </div>
    );
  }
  const { variant, icon, name, developer, where, code, art, attach } = props;
  return (
    <div data-header={variant} className={hasArt ? OUTER : OUTER_NO_ART}>
      <PaneArt src={art} />
      <div className="px-5 py-4 sm:px-6 passport:contents">
        <div className="flex items-center gap-4 passport:contents">
          <Icon art={hasArt}>{icon}</Icon>
          <div className="min-w-0 passport:contents">
            <p
              className={cn(
                "text-lg/6 text-fg-strong [overflow-wrap:anywhere] passport:text-balance passport:pt-4",
                PANE_TEXT,
              )}
            >
              {tParts(
                attach ? "signin.attach.header" : "signin.header.app",
                [attach ? "product" : "app"],
                {},
              ).map((part, i) =>
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
              <p
                className={cn(
                  "text-sm text-fg-muted [overflow-wrap:anywhere]",
                  PANE_TEXT,
                )}
              >
                {developer}
              </p>
            ) : null}
            <Where where={where} centered={!hasArt} />
          </div>
        </div>
        {code ? (
          <p
            data-code-panel
            className="mt-3 rounded-md bg-surface-sunken px-4 py-3 text-sm text-fg-muted passport:mx-6 passport:mt-4 passport:grid passport:border passport:border-border passport:bg-surface-raised"
          >
            {tParts("signin.header.codePanel", ["code"], {}).map((part, i) => (
              <React.Fragment key={i}>
                {i > 0 ? (
                  <span aria-hidden className="passport:hidden">
                    {" · "}
                  </span>
                ) : null}
                {typeof part === "string" ? (
                  <span className="passport:block">
                    {part.replace(/^[\s·]+|[\s·]+$/g, "")}
                  </span>
                ) : (
                  <span className="font-mono text-base font-semibold tracking-wider text-fg-strong passport:block passport:text-xl/7">
                    {code}
                  </span>
                )}
              </React.Fragment>
            ))}
          </p>
        ) : null}
      </div>
    </div>
  );
}
