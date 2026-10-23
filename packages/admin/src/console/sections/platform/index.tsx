/**
 * The Platform section's pages (notes/S-13 §9.1): instance-wide, product-less. One lazy chunk.
 * Status is built here; Settings, Store connections, Connections (I-31), Package
 * feeds and Override migration live in `pages/` and `../feeds/`.
 */

import * as React from "react";
import { api, type PlatformDeployment } from "../../../api.js";
import { PlatformActivityRoute } from "./pages/platformActivity.js";
import { PlatformStatus } from "./pages/platformStatus.js";
import { PlatformSettingsPage } from "./pages/platformSettings.js";
import { StoreConnections } from "./pages/platformStores.js";
import { ConnectionsRoute } from "./pages/platformConnections.js";
import type { GlobalPageId } from "../../nav.js";
import type { Route } from "../../routes.js";
import { FeedsArea } from "../feeds/pages/FeedsArea.js";
import { PLATFORM_SCOPE } from "../feeds/model/model.js";

export function fetchPlatformDeployment(): Promise<PlatformDeployment> {
  return api.platformDeployment();
}

export function fetchPlatformActivity() {
  return api.platformActivity();
}

/** The section's page for a route. A page that is not built redirects before here. */
export default function PlatformPages({
  page,
  route,
}: {
  page: GlobalPageId;
  route?: Extract<Route, { kind: "global" }>;
}): React.ReactElement | null {
  if (page === "platform-feeds")
    return (
      <FeedsArea
        scope={PLATFORM_SCOPE}
        eco={route?.id}
        tab={route?.tab}
        child={route?.child}
      />
    );
  if (page === "platform-status") return <Deployment />;
  if (page === "platform-activity")
    return <PlatformActivityRoute id={route?.id} />;
  if (page === "platform-settings") return <PlatformSettingsPage />;
  if (page === "platform-stores") return <StoreConnections />;
  if (page === "platform-connections")
    return <ConnectionsRoute id={route?.id} />;
  return null;
}

/** Platform → Status (admin.platform-status): Deployment and Operations in one page. */
export function Deployment(): React.ReactElement {
  return <PlatformStatus />;
}
