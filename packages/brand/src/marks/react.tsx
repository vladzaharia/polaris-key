// React components for the marks, lockups and "Powered by" badges. React is a peer dependency
// (18 or 19); nothing here uses an API newer than React 18, and the components are plain function
// components with no hooks, so they render on the server and in React Server Components.
//
// `PolarisMark` is a faithful port of the kit's kit/08-developer/PolarisMark.tsx (optical cut by
// displayed size, dark/light/mono themes, gold only when signed and >= 48 px, title or
// decorative), extended with the `bit` prop for the console's section bit (docs/design/BRAND.md
// "The section bit"). The default mark has no bit; `bit="none"` (or "core") says so explicitly.
// Lockups and badges render the kit's own artwork from colour templates. Nothing here emits an
// inline style, so the markup (lockup innerHTML included) is CSP-safe.

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
import {
  serviceIconInner,
  serviceIconTileInner,
  type ServiceIconOptions,
  type ServiceIconTileOptions,
} from "./icons.js";
import { SERVICE_ICON_GRID, type ServiceIconId } from "../tokens/icons.js";
import { serviceIconStroke } from "../tokens/icons.js";
import type { Theme } from "../tokens/source.js";
import { POWERED_BY } from "../tokens/primitives.js";
import { badgeSize } from "./core.js";

type SvgProps = Omit<
  React.SVGProps<SVGSVGElement>,
  "color" | "ref" | "children" | "dangerouslySetInnerHTML"
>;

const SVG_NS = "http://www.w3.org/2000/svg";

const round = (n: number) => Math.round(n * 100) / 100;

export type PolarisMarkProps = SvgProps & MarkOptions;

/**
 * The Pinned K or the Star Cut (Polaris Key Delivery) mark. Mono inherits currentColor. The optical cut follows
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
        <path key={i} d={p.d} fill={p.fill} className={p.className} />
      ))}
    </svg>
  );
}

export type PolarisLockupProps = SvgProps & LockupOptions;

/**
 * A kit wordmark lockup (horizontal, stacked or compact) for either mark. The default lockup has
 * no terminal bit; a section bit (`bit`) or the kit gold (`signed`) shows only while the glyph
 * renders at 48 px or more; use the compact lockup when the full wordmark would push the mark
 * below that.
 */
export function PolarisLockup({
  kind,
  layout,
  theme,
  height,
  trim,
  signed,
  bit,
  title,
  ...rest
}: PolarisLockupProps) {
  const opts = { kind, layout, theme, height, trim, signed, bit, title };
  const m = lockupMetrics(opts);
  const name = title ?? m.template.title;
  return (
    <svg
      xmlns={SVG_NS}
      width={round(m.width)}
      height={round(m.height)}
      viewBox={`${m.view.x} ${m.view.y} ${m.view.width} ${m.view.height}`}
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

export type ServiceIconProps = SvgProps &
  ServiceIconOptions & {
    /** The service (or commerce, packs) the icon names. */
    id: ServiceIconId;
    /**
     * Draw the §7.8 tile (a raised square with an accent border) instead of the bare glyph. The
     * tile sizes are 64, 48, 28 and 20; `theme` picks the ground.
     */
    tile?: boolean;
    theme?: Theme;
  };

/**
 * A service icon (BRAND.md §1.1): lucide's glyph on a 24 grid in currentColor, the stroke 2 up to
 * 20 px and 1.6 above. It never stands alone: the service's name sits beside it, so it is
 * decorative unless `title` is given. With `tile`, the size is one of the tile sizes and the
 * colours come from the section's accent.
 */
export function ServiceIcon({
  id,
  size,
  title,
  tile,
  theme,
  ...rest
}: ServiceIconProps) {
  if (tile) {
    const s = (size ?? 48) as ServiceIconTileOptions["size"] & number;
    return (
      <svg
        xmlns={SVG_NS}
        width={s}
        height={s}
        viewBox={`0 0 ${s} ${s}`}
        role={title ? "img" : undefined}
        aria-label={title || undefined}
        aria-hidden={title ? undefined : true}
        {...rest}
        dangerouslySetInnerHTML={{
          __html: serviceIconTileInner(id, { size: s, theme, title }),
        }}
      />
    );
  }
  const px = size ?? 24;
  return (
    <svg
      xmlns={SVG_NS}
      width={px}
      height={px}
      viewBox={`0 0 ${SERVICE_ICON_GRID} ${SERVICE_ICON_GRID}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={serviceIconStroke(px)}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? "img" : undefined}
      aria-label={title || undefined}
      aria-hidden={title ? undefined : true}
      {...rest}
      dangerouslySetInnerHTML={{
        __html: serviceIconInner(id, { size: px, title }),
      }}
    />
  );
}
