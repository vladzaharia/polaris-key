import * as React from "react";
import { PolarisLockup } from "@polaris-key/brand/react";
import { LogoMark, sectionBitFor } from "../../components/brand/Logo.js";
import { useTheme } from "../../components/theme.js";
import { cn } from "../../lib/cn.js";
import type { ServiceAccent } from "../nav.js";
import { Link } from "../router.js";
import { r } from "../routes.js";

/**
 * The top bar's brand block (ADMIN.md §2.2, components.md §1.2): the trimmed horizontal Polaris Key
 * lockup (BRAND.md §1.4, UK-57) from 640 px up, carrying the section bit on its mark, and the Pinned
 * K alone below that, so the product switcher keeps its room on tablets and phones (Key guide p.2:
 * the mark stays at 48 px; the bar never shrinks it to fit a wordmark). The name is drawn by the
 * lockup, never set as live text (BRAND.md Don'ts), and the link names it. It is the link to Home.
 *
 * Size: the lockup is 48 px tall, so its display-cut glyph is 48 px, in the 64 px top bar (8 px
 * clear space, BRAND.md §7.6; about 207 px wide). The bit is only drawn at >= 48 px (BRAND.md §6).
 *
 * The bit (BRAND.md §6, owner decision 2026-10-03): none on Home, Products and Core pages (the
 * bare Pinned K, the bit's path absent from the DOM); in a service section, that section's accent,
 * eased between sections under the reduced-motion rule. The brand package draws it from
 * `section`; the star never changes.
 */
export function BrandBlock({
  section,
  className,
}: {
  section: ServiceAccent;
  className?: string;
}): React.ReactElement {
  const { theme } = useTheme();
  return (
    <Link
      to={r.home()}
      aria-label="Polaris Key Console home"
      data-service={section}
      className={cn(
        "flex shrink-0 items-center rounded-md text-fg-strong",
        "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface-raised",
        className,
      )}
    >
      <PolarisLockup
        kind="key"
        layout="horizontal"
        theme={theme}
        height={48}
        trim
        bit={sectionBitFor(section)}
        title=""
        className="hidden sm:block"
      />
      <LogoMark size={48} section={section} title="" className="sm:hidden" />
    </Link>
  );
}
