import * as React from "react";
import { PolarisLockup } from "@polaris-key/brand/react";
import { LogoMark } from "../../components/brand/Logo.js";
import { useTheme } from "../../components/theme.js";
import { cn } from "../../lib/cn.js";
import type { ServiceAccent } from "../nav.js";
import { Link } from "../router.js";
import { r } from "../routes.js";

/**
 * The top bar's brand block (ADMIN.md §2.2, components.md §1.2): the kit's compact Polaris Key
 * lockup, as supplied (222 x 64 canvas, 52 px tall, 180 px wide: the size plrs.im draws), from
 * 832 px up, and the Pinned K alone below that so the product switcher keeps its room. Key guide
 * p.2: the compact lockup is the one to use when the full wordmark would make the mark smaller
 * than 48 px, and a 64 px bar is that case. The name is drawn by the lockup, never live text
 * (BRAND.md Don'ts); the link names it. It is the link to Home.
 *
 * The compact lockup's mark is 26 px, below the 48 px the section bit needs (BRAND.md §6), so the
 * bit shows only on the standalone mark below 832 px; the section is still on `data-service`.
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
        layout="compact"
        theme={theme}
        height={52}
        title=""
        className="hidden min-[52rem]:block"
      />
      <LogoMark
        size={48}
        section={section}
        title=""
        className="min-[52rem]:hidden"
      />
    </Link>
  );
}
