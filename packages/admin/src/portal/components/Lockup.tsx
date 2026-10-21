import * as React from "react";
import { PolarisLockup, PolarisMark } from "@polaris-key/brand/react";
import { useTheme } from "../../components/theme.js";

/**
 * The Polaris Locker horizontal lockup, trimmed to the mark and the outlined wordmark
 * (`LOCKER_TRIM`; the kit's canvas margin made it read small in a header), in the active theme.
 * The name is drawn, never live text (BRAND.md Don'ts). The Locker guide (p.7) sets 180 px as the
 * horizontal lockup's minimum width, which this trim reaches from 33 px tall (437 x 80 canvas).
 * Decorative here: the link around it carries the name.
 */
export function Lockup({
  height = 40,
  className,
}: {
  height?: number;
  className?: string;
}): React.ReactElement {
  const { theme } = useTheme();
  return (
    <PolarisLockup
      kind="locker"
      layout="horizontal"
      theme={theme}
      height={height}
      trim
      title=""
      className={className}
    />
  );
}

/**
 * The header's brand: the lockup, or, where the row has no room for a 180 px lockup (guide p.7:
 * "for crowded navigation use the mark alone with an accessible label"), the mark alone. The
 * enclosing link names it.
 */
export function HeaderBrand(): React.ReactElement {
  const { theme } = useTheme();
  return (
    <>
      <Lockup height={36} className="hidden min-[24rem]:block desk:hidden" />
      <Lockup height={40} className="hidden desk:block" />
      <PolarisMark
        kind="locker"
        size={32}
        theme={theme}
        title=""
        className="min-[24rem]:hidden"
      />
    </>
  );
}

/**
 * The sign-in card's brand row (SIGN-IN.md §3.1): 36 px on a phone, where a 48 px lockup sat 4 px
 * from the card's top edge (B-066; BRAND.md sets 36), 48 px from `sm`. The size never changes
 * between steps.
 */
export function AuthLockup(): React.ReactElement {
  return (
    <>
      <Lockup height={36} className="sm:hidden" />
      <Lockup height={48} className="hidden sm:block" />
    </>
  );
}
