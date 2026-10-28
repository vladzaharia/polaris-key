import * as React from "react";
import { PolarisLockup, PolarisMark } from "@polaris-key/brand/react";
import { useTheme } from "../../components/theme.js";

/**
 * The Polaris Locker horizontal lockup, trimmed to the mark and the outlined wordmark
 * (`LOCKER_TRIM`; the kit's canvas margin made it read small in a header), in the active theme.
 * The name is drawn, never live text (BRAND.md Don'ts). BRAND.md §1.4 sets the proportion
 * (mark 1.5 x the cap height, centred on it) and the Locker guide (p.7) 180 px as the minimum
 * width, which this trim reaches from 22 px tall. Size it by the wordmark: 23 px tall sets the
 * name at about 22 px.
 * Decorative here: the link around it carries the name.
 */
export function Lockup({
  height = 23,
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
 * The header's brand: the lockup, or, where the row has no room for a 190 px lockup (guide p.7:
 * "for crowded navigation use the mark alone with an accessible label"), the mark alone. The
 * enclosing link names it.
 */
export function HeaderBrand({
  container = false,
}: {
  /**
   * Switch on the enclosing container's width (`@container`) rather than the window's: a header
   * that sets its own container follows the root font size, so large text gives the mark first.
   */
  container?: boolean;
} = {}): React.ReactElement {
  const { theme } = useTheme();
  // Container mode: the 23 px lockup only while the header is under `desk` and wide enough for it.
  // The two conditions are one rule, so no later rule can show it beside the desktop lockup.
  const phoneLockup = container
    ? "hidden max-desk:@min-[24rem]:block"
    : "hidden min-[24rem]:block desk:hidden";
  return (
    <>
      <Lockup height={23} className={phoneLockup} />
      <Lockup height={23} className="hidden desk:block" />
      <PolarisMark
        kind="locker"
        size={32}
        theme={theme}
        title=""
        className={container ? "@min-[24rem]:hidden" : "min-[24rem]:hidden"}
      />
    </>
  );
}

/**
 * The sign-in card's brand row (SIGN-IN.md §3.1; a card's lockup, not a header's 23 px): 26 px on a phone (the name at about 25 px, clear of the card's
 * top edge, B-066), 30 px from `sm`. The size never changes
 * between steps.
 */
export function AuthLockup(): React.ReactElement {
  return (
    <>
      <Lockup height={26} className="sm:hidden" />
      <Lockup height={30} className="hidden sm:block" />
    </>
  );
}
