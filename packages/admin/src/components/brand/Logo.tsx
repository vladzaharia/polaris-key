import * as React from "react";
import type { BitColor } from "@polaris-key/brand";
import { PolarisLockup, PolarisMark } from "@polaris-key/brand/react";
import type { ServiceAccent } from "../../console/nav.js";
import { cn } from "../../lib/cn.js";
import { useTheme } from "../theme.js";

/**
 * The console's marks, from @polaris-key/brand (docs/design/BRAND.md). Nothing is drawn here:
 * the Pinned K comes from the launch kit through `PolarisMark`, which picks the optical cut from
 * the displayed size (favicon < 24, service 24–32, display > 32; the terminal bit only at
 * >= 48 px) and colours it for the ground it sits on, so the mark follows the active theme.
 *
 * The default Polaris Key mark has NO terminal bit (BRAND.md §6, owner decision 2026-10-03):
 * core/platform pages, the portal, the boot screen and sign-in show the bare K, with the bit's
 * path left out of the DOM. Only a service section draws the bit, in that section's accent.
 */

/** The mark's bit for a section: none on core (or no section), the section's accent otherwise. */
export function sectionBitFor(section: ServiceAccent | undefined): BitColor {
  return section === undefined || section === "core" ? "none" : section;
}

/**
 * The Pinned K. `size` is the displayed CSS size; keep it >= 24 (BRAND.md §1.3). With no
 * `section` (or `section="core"`) it has no terminal bit; in a service section (48 px and up) the
 * bit takes that section's accent for the active theme, and eases between sections. `title`
 * names it; pass `""` when an adjacent visible label already does.
 */
export function LogoMark({
  className,
  size = 24,
  section,
  title = "Polaris Key",
}: {
  className?: string;
  size?: number;
  section?: ServiceAccent;
  title?: string;
}): React.ReactElement {
  const { theme } = useTheme();
  return (
    <PolarisMark
      kind="key"
      size={size}
      theme={theme}
      bit={sectionBitFor(section)}
      title={title}
      // Not the kit's `.polaris-mark` class: tokens.css declares it unlayered, so its
      // `display: inline-block` would beat a layered utility such as `lg:hidden`.
      className={className}
    />
  );
}

/**
 * The Polaris Key brand block for a page or boot screen: the trimmed horizontal lockup (BRAND.md
 * §1.4), 56 px tall so the display-cut glyph is 56 px (the Key guide, p.2, asks for >= 48 px), then
 * an optional muted suffix (e.g. "console"). The name is drawn by the lockup and named for assistive
 * technology by its own title; it is never live text (BRAND.md Don'ts). The mark carries the section
 * bit only inside a service section (`section`); on core pages and in the portal it has none. The
 * host supplies the clear space (a quarter of the glyph, 14 px).
 */
export function Logo({
  className,
  subtitle,
  section,
}: {
  className?: string;
  subtitle?: string;
  section?: ServiceAccent;
}): React.ReactElement {
  const { theme } = useTheme();
  return (
    <span className={cn("inline-flex items-center gap-3 text-fg", className)}>
      <PolarisLockup
        kind="key"
        layout="horizontal"
        theme={theme}
        height={56}
        trim
        bit={sectionBitFor(section)}
        title="Polaris Key"
        className="max-w-full"
      />
      {subtitle ? (
        <span className="text-xs font-normal uppercase tracking-wider text-fg-muted">
          {subtitle}
        </span>
      ) : null}
    </span>
  );
}
