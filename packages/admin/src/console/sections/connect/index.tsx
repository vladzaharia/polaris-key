import type * as React from "react";
import type { SectionPageProps } from "../../pages/types.js";
import { ConnectSetupPage } from "./ConnectSetup.js";

/** Cloud Connect's section: Setup now; Usage and Linked devices are later CC-16 slices. */
export default function ConnectPages({
  route,
}: SectionPageProps): React.ReactElement | null {
  return route.page === "connect-setup" ? (
    <ConnectSetupPage slug={route.slug} />
  ) : null;
}
