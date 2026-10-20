import * as React from "react";
import { LogoLockup, LogoMark } from "../../components/brand/Logo.js";
import { cn } from "../../lib/cn.js";
import { Link } from "../router.js";
import { r } from "../routes.js";

/**
 * The top bar's brand block (ADMIN.md §2.2, LK-00 §14.5): the Polaris Locker lockup from 640 px
 * up, the Bookends mark alone below. It is the link to Home.
 *
 * No section bit and no `data-service`: the console header is the Locker identity everywhere
 * (this reverses the owner decision of 2026-10-03 on the owner's newer direction). The section
 * is carried by the sidebar's glyph chip and service tiles.
 */
export function BrandBlock({
  className,
}: {
  className?: string;
}): React.ReactElement {
  return (
    <Link
      to={r.home()}
      aria-label="Polaris Locker console home"
      className={cn(
        "flex shrink-0 items-center gap-3 rounded-md text-fg-strong",
        "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface-raised",
        className,
      )}
    >
      <LogoMark size={32} title="" className="sm:hidden" />
      <LogoLockup height={32} className="hidden sm:block" />
    </Link>
  );
}
