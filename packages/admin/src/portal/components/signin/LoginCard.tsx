import * as React from "react";
import { cn } from "../../../lib/cn.js";
import { Lockup } from "../Lockup.js";
import { ProductIcon } from "../ProductIcon.js";

/**
 * The one sign-in frame (PORTAL.md §4.1, §5.2 `LoginCard`): the lockup above, the 456 px card
 * with its optional persistent `header`, the step `children` (one primary each) and the
 * passthrough `footer`, the legal line below, on the static star field (wide screens only).
 * Phones: the card goes edge to edge under a 56 px lockup row.
 *
 * Focus: every step's `h1` receives focus when the step changes (`stepKey`).
 */
export function LoginCard({
  header,
  footer,
  stepKey,
  children,
}: {
  header?: React.ReactNode;
  footer?: React.ReactNode;
  /** Changes with the step; the new step's h1 is focused. */
  stepKey: string;
  children: React.ReactNode;
}): React.ReactElement {
  const bodyRef = React.useRef<HTMLDivElement>(null);
  const first = React.useRef(true);
  React.useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    bodyRef.current?.querySelector<HTMLElement>("h1")?.focus();
  }, [stepKey]);
  return (
    <div className="relative flex min-h-dvh flex-col bg-surface-page text-fg">
      <StarField />
      <div className="relative z-10 flex h-14 items-center justify-center border-b border-border sm:h-auto sm:border-0 sm:pb-8 sm:pt-[12vh]">
        <Lockup height={36} />
      </div>
      <main className="relative z-10 flex flex-1 flex-col items-center sm:px-4">
        <div className="w-full overflow-hidden bg-surface-raised sm:max-w-[28.5rem] sm:rounded-xl sm:border sm:border-border sm:shadow-elevation-2">
          {header ? (
            <div className="border-b border-border">{header}</div>
          ) : null}
          <div ref={bodyRef} className="space-y-5 px-5 py-6 sm:px-7 sm:py-8">
            {children}
          </div>
          {footer ? (
            <div className="border-t border-border px-5 py-4 text-sm text-fg-muted sm:px-7">
              {footer}
            </div>
          ) : null}
        </div>
        <footer className="flex w-full max-w-[28.5rem] flex-wrap justify-between gap-2 px-5 py-6 text-sm text-fg-muted sm:px-1">
          <span>Polaris Key · key.plrs.im</span>
        </footer>
      </main>
    </div>
  );
}

/** The card header, data only (§5.2 `CardHeader`): today only the product-context variant. */
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
          Manage your copy of <span className="font-bold">{name}</span>
        </p>
        <p className="text-sm text-fg-muted">
          {[developer, "downloads, license and devices"]
            .filter(Boolean)
            .join(" · ")}
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
