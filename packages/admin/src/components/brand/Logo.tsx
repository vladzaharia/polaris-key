import * as React from "react";
import { PolarisMark } from "@polaris-key/brand/react";
import { cn } from "../../lib/cn.js";
import { useTheme } from "../theme.js";

/**
 * The console's marks, from @polaris-key/brand (docs/design/BRAND.md). Nothing is drawn here:
 * the Pinned K comes from the launch kit through `PolarisMark`, which picks the optical cut from
 * the displayed size (favicon < 24, service 24–32, display > 32; the terminal bit only at
 * >= 48 px) and colours it for the ground it sits on, so the mark follows the active theme.
 */

/**
 * The Pinned K. `size` is the displayed CSS size; keep it >= 24 (BRAND.md §1.3). With
 * `bit="section"` (48 px and up) the terminal bit takes the current section's accent through
 * `--pk-section-bit` from the nearest `data-service` ancestor: the kit gold on core/platform
 * pages, the section colour elsewhere (BRAND.md §6). `title` names it; pass `""` when an
 * adjacent visible label already does.
 */
export function LogoMark({
  className,
  size = 24,
  bit,
  title = "Polaris Key",
}: {
  className?: string;
  size?: number;
  bit?: "section";
  title?: string;
}): React.ReactElement {
  const { theme } = useTheme();
  return (
    <PolarisMark
      kind="key"
      size={size}
      theme={theme}
      bit={bit}
      title={title}
      className={cn("polaris-mark", className)}
    />
  );
}

/**
 * The console header's brand block: the 48 px display-cut Pinned K carrying the section bit,
 * then the product name and an optional muted suffix (e.g. "admin"). The name is UI text beside
 * the mark, not a redrawn wordmark; it is hidden from assistive technology because the mark's
 * own name ("Polaris Key") already says it once. Clear space: the block is inset by 8 px inside
 * a 64 px header, the arrangement BRAND.md §6 proves legible.
 */
export function Logo({
  className,
  subtitle,
}: {
  className?: string;
  subtitle?: string;
}): React.ReactElement {
  return (
    <span className={cn("inline-flex items-center gap-3 text-fg", className)}>
      <LogoMark size={48} bit="section" />
      <span
        className="flex items-baseline gap-1.5 font-bold tracking-tight text-fg-strong"
        aria-hidden
      >
        Polaris&nbsp;Key
        {subtitle ? (
          <span className="text-xs font-normal uppercase tracking-wider text-fg-muted">
            {subtitle}
          </span>
        ) : null}
      </span>
    </span>
  );
}
