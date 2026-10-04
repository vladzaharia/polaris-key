import * as React from "react";
import { Announcer } from "../ui/LiveRegion.js";
import { TooltipProvider } from "../ui/Tooltip.js";

/**
 * What every kit story needs around it: the shared announcer and the tooltip provider. The
 * gallery page and the jsdom axe suite both wrap stories in this, so a story renders the same in
 * both. (The toaster is mounted by the gallery page only: axe runs per story.)
 */
export function KitProviders({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <TooltipProvider delayDuration={300}>
      {children}
      <Announcer />
    </TooltipProvider>
  );
}
