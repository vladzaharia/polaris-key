import * as React from "react";
import { cn } from "../../../lib/cn.js";
import { Lockup } from "../Lockup.js";
import { ProductIcon } from "../ProductIcon.js";

/**
 * The one sign-in frame (SIGN-IN.md §3.1, PORTAL.md §5.2 `LoginCard`): the lockup above, the
 * 28.5 rem card (radius 22 px, elevation 3) with its optional persistent `header`, the step
 * `children` (one primary each) and the passthrough `footer`, on the static star field (wide
 * screens only). Phones: the card goes edge to edge under a 56 px lockup row. No
 * "Polaris Key · key.plrs.im" line under the card.
 *
 * Steps replace each other in place (§3.18, S-23 tokens): when `stepKey` changes the body's
 * height morphs from the old size to the new one at `moderate` (the Web Animations API, which the
 * strict CSP allows), the new step enters `lg` (12 px) from the side of travel (`direction`) at
 * `base`, focus moves to its h1 and the polite live region announces it once. The header and
 * footer stay still. Under reduced motion (the OS setting or `data-motion="reduce"`) the brand's
 * durations are 0 ms, so every step swaps instantly with no fade (S-23 D3).
 */
export function LoginCard({
  header,
  footer,
  stepKey,
  direction = "forward",
  children,
}: {
  header?: React.ReactNode;
  footer?: React.ReactNode;
  /** Changes with the step; the new step's h1 is focused. */
  stepKey: string;
  /** Which way the flow went: Back, Change and Use a different email enter from the start. */
  direction?: "forward" | "back";
  children: React.ReactNode;
}): React.ReactElement {
  const bodyRef = React.useRef<HTMLDivElement>(null);
  const lastHeight = React.useRef<number | null>(null);
  const first = React.useRef(true);
  const [announce, setAnnounce] = React.useState("");

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

  return (
    <div className="relative flex min-h-dvh flex-col bg-surface-page text-fg">
      <StarField />
      <div className="relative z-10 flex h-14 items-center justify-center border-b border-border sm:h-auto sm:border-0 sm:pb-4 sm:pt-[10vh]">
        <Lockup height={64} className="hidden sm:block" />
        <Lockup height={52} className="sm:hidden" />
      </div>
      <main className="relative z-10 flex flex-1 flex-col items-center sm:px-4">
        <div className="w-full overflow-hidden bg-surface-raised sm:mb-6 sm:max-w-[28.5rem] sm:rounded-[1.375rem] sm:border sm:border-border sm:shadow-pk-lg">
          {header ? (
            <div className="border-b border-border">{header}</div>
          ) : null}
          <div ref={bodyRef} className="overflow-hidden">
            <div
              key={stepKey}
              data-step={stepKey}
              className={cn(
                "space-y-5 px-5 py-6 sm:px-7 sm:py-8",
                !first.current &&
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
  slug,
  name,
  developer,
}: {
  variant: "context";
  slug: string;
  name: string;
  developer: string | null;
}): React.ReactElement {
  return (
    <div
      data-variant={variant}
      className="flex items-center gap-4 px-5 py-4 sm:px-7"
    >
      <ProductIcon slug={slug} name={name} tint={null} size={48} />
      <div className="min-w-0">
        <p className="text-fg-strong">
          <span className="font-bold">{name}</span>
          {developer ? ` · ${developer}` : null}
        </p>
        <p className="text-sm text-fg-muted">
          Your license, downloads and devices
        </p>
      </div>
    </div>
  );
}

/** A sparse, static star field behind the card on wide screens. Nothing moves. */
const STARS: readonly [number, number, number][] = [
  [6, 8, 1.2],
  [14, 30, 0.8],
  [22, 64, 1],
  [9, 82, 0.8],
  [31, 14, 0.8],
  [38, 88, 1.2],
  [47, 6, 0.8],
  [62, 10, 1],
  [70, 26, 0.8],
  [84, 12, 1.2],
  [93, 34, 0.8],
  [88, 58, 1],
  [96, 80, 0.8],
  [76, 90, 1],
  [58, 94, 0.8],
  [18, 48, 0.8],
  [80, 72, 0.8],
  [4, 60, 1],
];

function StarField(): React.ReactElement {
  return (
    <svg
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-0 hidden size-full text-fg-subtle opacity-60 sm:block",
      )}
      preserveAspectRatio="none"
    >
      {STARS.map(([x, y, r], i) => (
        <circle
          key={i}
          cx={`${x}%`}
          cy={`${y}%`}
          r={r}
          className="fill-current"
        />
      ))}
    </svg>
  );
}
