import * as React from "react";
import { PolarisLockup, PolarisMark } from "@polaris-key/brand/react";
import { cn } from "../../lib/cn.js";
import { useTheme } from "../theme.js";

/**
 * The console's marks, from @polaris-key/brand (docs/design/BRAND.md §15). Nothing is drawn here:
 * the Bookends come from the Polaris Locker kit through `PolarisMark` and `PolarisLockup`
 * (`kind: "locker"`), which pick the optical cut from the displayed size and colour it for the
 * ground it sits on, so the mark follows the active theme.
 *
 * The console wears the Locker identity (LK-00 §14.2, A3): no section bit. The section is carried
 * by the sidebar's glyph chip and service tiles, not by the header mark.
 */

/** The Bookends mark. `size` is the displayed CSS size; `title` names it (`""` when decorative). */
export function LogoMark({
  className,
  size = 24,
  title = "Polaris Locker",
}: {
  className?: string;
  size?: number;
  title?: string;
}): React.ReactElement {
  const { theme } = useTheme();
  return (
    <PolarisMark
      kind="locker"
      size={size}
      theme={theme}
      title={title}
      className={className}
    />
  );
}

/** The kit's horizontal Polaris Locker lockup at `height` CSS px, outlined Rubik as supplied. */
export function LogoLockup({
  className,
  height = 32,
}: {
  className?: string;
  height?: number;
}): React.ReactElement {
  const { theme } = useTheme();
  return (
    <PolarisLockup
      kind="locker"
      layout="horizontal"
      theme={theme}
      height={height}
      className={className}
    />
  );
}

/**
 * The boot and sign-in lockup: the horizontal Locker lockup over an optional muted suffix
 * (e.g. "console"). The lockup names itself ("Polaris Locker"); the suffix is UI text.
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
      <LogoLockup height={40} />
      {subtitle ? (
        <span className="text-xs font-normal uppercase tracking-wider text-fg-muted">
          {subtitle}
        </span>
      ) : null}
    </span>
  );
}
