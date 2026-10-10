import * as React from "react";
import { LogoMark } from "../../components/brand/Logo.js";
import { cn } from "../../lib/cn.js";
import type { ServiceAccent } from "../nav.js";
import { Link } from "../router.js";
import { r } from "../routes.js";

/**
 * The top bar's brand block (ADMIN.md §2.2, components.md §1.2): the Pinned K carrying the
 * section bit, and the "Polaris Key" name from 640 px up. It is the link to Home.
 *
 * Size: 48 px, the display cut, in the 64 px top bar. BRAND.md §6 and the owner decision of
 * 2026-10-03 settle ADMIN.md's open question Q1 that way: the bit is only drawn at ≥ 48 px, and
 * the proofs show every section's bit legible there in both themes.
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
  return (
    <Link
      to={r.home()}
      aria-label="Polaris Key home"
      data-service={section}
      className={cn(
        "flex shrink-0 items-center gap-3 rounded-md text-fg-strong",
        "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface-raised",
        className,
      )}
    >
      <LogoMark size={48} section={section} title="" />
      <span
        aria-hidden
        className="hidden whitespace-nowrap text-base font-semibold tracking-tight sm:inline"
      >
        Polaris Key
      </span>
    </Link>
  );
}
