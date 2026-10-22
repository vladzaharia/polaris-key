import * as React from "react";
import { SyncDataPage } from "./pages/SyncData.js";
import { SyncUsagePage } from "./pages/SyncUsage.js";
import { CloudSyncSetupPage } from "./CloudSyncSetup.js";
import type { SectionPageProps } from "../../pages/types.js";

/** Cloud Sync: one row, Setup, Usage and Data route tabs. */
export default function SyncPages({
  route,
}: SectionPageProps): React.ReactElement | null {
  switch (route.page) {
    case "sync-setup":
      return <CloudSyncSetupPage slug={route.slug} />;
    case "sync-usage":
      return <SyncUsagePage slug={route.slug} />;
    case "sync-data":
      return <SyncDataPage slug={route.slug} />;
    default:
      return null;
  }
}
