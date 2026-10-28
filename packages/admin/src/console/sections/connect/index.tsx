import type * as React from "react";
import type { SectionPageProps } from "../../pages/types.js";
import { ConnectDevicesPage } from "./ConnectDevices.js";
import { ConnectSetupPage } from "./ConnectSetup.js";
import { ConnectUsagePage } from "./ConnectUsage.js";

/** Cloud Connect: one row, Setup, Linked devices and Usage route tabs. */
export default function ConnectPages({
  route,
}: SectionPageProps): React.ReactElement | null {
  switch (route.page) {
    case "connect-setup":
      return <ConnectSetupPage slug={route.slug} />;
    case "connect-devices":
      return <ConnectDevicesPage slug={route.slug} />;
    case "connect-usage":
      return <ConnectUsagePage slug={route.slug} />;
    default:
      return null;
  }
}
