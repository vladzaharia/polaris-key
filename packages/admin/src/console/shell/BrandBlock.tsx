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
 * The bit: `data-service` on the link re-points `--pk-section-bit`, so the mark's bit takes the
 * current section's accent (the brand package draws it and eases between colours under the
 * reduced-motion rule). The star never changes.
 *
 * INTEGRATION PENDING: `fix/logo-no-core-bit` changes the brand API so the default mark has no
 * bit and only service sections draw one. When it merges, this block passes `section={section}`
 * to `LogoMark` instead of `bit="section"`, and nothing else here changes.
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
      <LogoMark size={48} bit="section" title="" />
      <span
        aria-hidden
        className="hidden text-base font-bold tracking-tight sm:inline"
      >
        Polaris Key
      </span>
    </Link>
  );
}
