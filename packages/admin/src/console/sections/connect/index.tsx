import type * as React from "react";
import type { SectionPageProps } from "../../pages/types.js";
import { ConnectSetupPage } from "./ConnectSetup.js";

/** Cloud Connect's section: the stub page now; Setup, Usage and Linked devices come with CC-16. */
export default function ConnectPages({
  route,
}: SectionPageProps): React.ReactElement | null {
  return route.page === "connect-setup" ? <ConnectSetupPage /> : null;
}
