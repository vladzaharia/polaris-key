import * as React from "react";
import { cn } from "../../lib/cn.js";

/**
 * The Polaris Key mark: a four-point north-star whose lower ray extends into a key shaft +
 * bit — "polaris" (the guiding star) fused with "key" (the credential). Drawn with
 * `currentColor` so it inherits text color; the inner star core uses the brand accent.
 */
export function LogoMark({
  className,
  title = "Polaris Key",
}: {
  className?: string;
  title?: string;
}): React.ReactElement {
  return (
    <svg
      viewBox="0 0 32 32"
      role="img"
      aria-label={title}
      className={cn("size-6", className)}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* North-star: four tapered rays meeting at center. */}
      <path
        d="M16 1.5l2.4 9.1 9.1 2.4-9.1 2.4-1.2 4.6a5.2 5.2 0 1 1-4.4 0l-1.2-4.6-9.1-2.4 9.1-2.4L16 1.5z"
        fill="hsl(var(--pk-primary))"
        opacity="0.18"
      />
      <path
        d="M16 2l2.2 8.8L27 13l-8.8 2.2L16 24l-2.2-8.8L5 13l8.8-2.2L16 2z"
        fill="hsl(var(--pk-primary))"
      />
      {/* Key ring + bit at the lower ray. */}
      <circle cx="16" cy="25" r="4.2" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M16 27.6v2.9M16 29h2.2"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <circle cx="16" cy="25" r="1.4" fill="currentColor" />
    </svg>
  );
}

/** The full lockup: mark + wordmark. `subtitle` renders a muted suffix (e.g. "admin"). */
export function Logo({
  className,
  subtitle,
  markClassName,
}: {
  className?: string;
  subtitle?: string;
  markClassName?: string;
}): React.ReactElement {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 text-foreground",
        className,
      )}
    >
      <LogoMark className={markClassName} />
      <span className="flex items-baseline gap-1.5 font-semibold tracking-tight">
        Polaris&nbsp;Key
        {subtitle ? (
          <span className="text-xs font-normal uppercase tracking-wider text-muted-foreground">
            {subtitle}
          </span>
        ) : null}
      </span>
    </span>
  );
}
