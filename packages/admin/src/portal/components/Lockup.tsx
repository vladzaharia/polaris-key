import * as React from "react";
import { PolarisLockup } from "@polaris-key/brand/react";
import { portalBrand } from "../brand.js";
import { useTheme } from "../../components/theme.js";

/**
 * The kit's compact lockup (PORTAL.md §0.3): Polaris Locker while `customer.host` is on, else the
 * Pinned K with no section bit, in the active theme. Decorative here: the link around it carries the name.
 */
export function Lockup({
  height = 32,
  className,
}: {
  height?: number;
  className?: string;
}): React.ReactElement {
  const { theme } = useTheme();
  return (
    <PolarisLockup
      kind={portalBrand()}
      layout="compact"
      theme={theme}
      height={height}
      title=""
      className={className}
    />
  );
}
