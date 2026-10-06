import * as React from "react";
import { SyncDataPage } from "./sync/SyncData.js";
import type { SectionPageProps } from "./types.js";

/** Cloud Sync (U-04): Data, read-only, over the catalog's declarations. */
export default function SyncPages({
  route,
}: SectionPageProps): React.ReactElement | null {
  return route.page === "sync-data" ? <SyncDataPage slug={route.slug} /> : null;
}
