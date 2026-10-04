import * as React from "react";
import { PolarisLockup } from "@polaris-key/brand/react";
import { useTheme } from "../../components/theme.js";

/**
 * The kit's compact Polaris Key lockup (PORTAL.md §0.3): the Pinned K with no section bit, in the
 * active theme. Decorative here: the link around it carries the name.
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
      kind="key"
      layout="compact"
      theme={theme}
      height={height}
      title=""
      className={className}
    />
  );
}
