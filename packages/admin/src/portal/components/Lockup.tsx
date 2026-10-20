import * as React from "react";
import { PolarisLockup } from "@polaris-key/brand/react";
import { useTheme } from "../../components/theme.js";

/**
 * The Polaris Locker horizontal lockup (BRAND §15: 120 px minimum width) in the active theme.
 * Decorative here: the link around it carries the name.
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
      kind="locker"
      layout="horizontal"
      theme={theme}
      height={height}
      title=""
      className={className}
    />
  );
}
