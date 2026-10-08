import * as React from "react";
import type { QueryClient } from "@tanstack/react-query";
import { ConsoleQueryProvider } from "../console/data/queryClient.js";
import { Announcer } from "../ui/LiveRegion.js";
import { TooltipProvider } from "../ui/Tooltip.js";

/**
 * What every kit story needs around it: a query client of its own, the shared announcer and the
 * tooltip provider. The gallery page and the jsdom suites both wrap what they render in this, so a
 * story renders the same in both and every mount starts from an empty cache unless it is handed a
 * client to share. (The toaster is mounted by the gallery page only: axe runs per story.)
 */
export function KitProviders({
  queryClient,
  children,
}: {
  /** A client to share across mounts (a test's); by default each mount creates its own. */
  queryClient?: QueryClient;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <ConsoleQueryProvider client={queryClient}>
      <TooltipProvider delayDuration={300}>
        {children}
        <Announcer />
      </TooltipProvider>
    </ConsoleQueryProvider>
  );
}
