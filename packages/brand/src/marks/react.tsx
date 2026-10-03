// React components for the marks, lockups and "Powered by" badges. React is a peer dependency
// (18 or 19); nothing here uses an API newer than React 18, and the components are plain function
// components with no hooks, so they render on the server and in React Server Components.
//
// `PolarisMark` is a faithful port of the kit's kit/08-developer/PolarisMark.tsx (optical cut by
// displayed size, dark/light/mono themes, gold only when signed and >= 48 px, title or
// decorative), extended with the `bit` prop for the console's section bit (docs/design/BRAND.md
// "The section bit"). Lockups and badges render the kit's own artwork from colour templates.

import * as React from "react";

import {
  lockupInner,
  lockupMetrics,
  markParts,
  poweredByInner,
  type BadgeOptions,
  type LockupOptions,
  type MarkOptions,
} from "./svg.js";
import { BADGE_TEMPLATES } from "../generated/layouts.js";
import { POWERED_BY } from "../tokens/primitives.js";
import { badgeSize } from "./core.js";

type SvgProps = Omit<
  React.SVGProps<SVGSVGElement>,
  "color" | "ref" | "children" | "dangerouslySetInnerHTML"
>;

const SVG_NS = "http://www.w3.org/2000/svg";

const round = (n: number) => Math.round(n * 100) / 100;

function parseStyle(style: string): React.CSSProperties {
  const out: Record<string, string> = {};
  for (const decl of style.split(";")) {
    const i = decl.indexOf(":");
    if (i > 0) out[decl.slice(0, i).trim()] = decl.slice(i + 1).trim();
  }
  return out as React.CSSProperties;
}

export type PolarisMarkProps = SvgProps & MarkOptions;

/**
 * The Pinned K or the Star Cut Update mark. Mono inherits currentColor. The optical cut follows
 * the displayed `size`, never the device pixel ratio.
 */
export function PolarisMark({
  kind,
  size,
  theme,
  signed,
  bit,
  title,
  ...rest
}: PolarisMarkProps) {
  const m = markParts({ kind, size, theme, signed, bit, title });
  return (
    <svg
      xmlns={SVG_NS}
      width={m.size}
      height={m.size}
      viewBox={`0 0 ${m.grid} ${m.grid}`}
      role={title ? "img" : undefined}
      aria-label={title || undefined}
      aria-hidden={title ? undefined : true}
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {m.parts.map((p, i) => (
        <path
          key={i}
          d={p.d}
          fill={p.fill}
          style={p.style ? parseStyle(p.style) : undefined}
          className={p.className}
        />
      ))}
    </svg>
  );
}

export type PolarisLockupProps = SvgProps & LockupOptions;

/**
 * A kit wordmark lockup (horizontal, stacked or compact) for either mark. The K's terminal bit
 * shows only while the glyph renders at 48 px or more; use the compact lockup when the full
 * wordmark would push the mark below that.
 */
export function PolarisLockup({
  kind,
  layout,
  theme,
  height,
  signed,
  bit,
  title,
  ...rest
}: PolarisLockupProps) {
  const opts = { kind, layout, theme, height, signed, bit, title };
  const m = lockupMetrics(opts);
  const name = title ?? m.template.title;
  return (
    <svg
      xmlns={SVG_NS}
      width={round(m.width)}
      height={round(m.height)}
      viewBox={`0 0 ${m.template.width} ${m.template.height}`}
      role={name ? "img" : undefined}
      aria-label={name || undefined}
      aria-hidden={name ? undefined : true}
      {...rest}
      dangerouslySetInnerHTML={{ __html: lockupInner(opts) }}
    />
  );
}

export type PoweredByBadgeProps = SvgProps & BadgeOptions;

function warnBelowMinimum(
  layout: keyof typeof POWERED_BY.minimum,
  width: number | undefined,
) {
  if (width === undefined) return;
  const min = POWERED_BY.minimum[layout].width;
  if (width >= min) return;
  const env = (
    globalThis as { process?: { env?: Record<string, string | undefined> } }
  ).process?.env;
  if (env?.NODE_ENV === "production") return;
  console.warn(
    `PoweredByBadge: width ${width} is below the ${layout} minimum of ${min} CSS px; rendering at ${min}.`,
  );
}

/**
 * "Powered by Polaris Key", from the kit's badges. Never smaller than the layout's minimum
 * (horizontal 376×144, compact 232×88, stacked 288×336): a smaller `width` is raised to it.
 * The badge's built-in padding is part of the artwork; do not crop it.
 */
export function PoweredByBadge({
  layout,
  treatment,
  theme,
  width,
  title,
  ...rest
}: PoweredByBadgeProps) {
  const l = layout ?? "compact";
  const t = BADGE_TEMPLATES[treatment ?? "transparent"][l];
  const size = badgeSize(l, width);
  warnBelowMinimum(l, width);
  const name = title ?? POWERED_BY.phrase;
  return (
    <svg
      xmlns={SVG_NS}
      width={round(size.width)}
      height={round(size.height)}
      viewBox={`0 0 ${t.width} ${t.height}`}
      role={name ? "img" : undefined}
      aria-label={name || undefined}
      aria-hidden={name ? undefined : true}
      {...rest}
      dangerouslySetInnerHTML={{
        __html: poweredByInner({ layout, treatment, theme, width, title }),
      }}
    />
  );
}
