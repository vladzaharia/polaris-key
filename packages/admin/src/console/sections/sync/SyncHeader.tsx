/**
 * The header Cloud Sync's three pages share: one row in the sidebar, one h1, and route tabs for
 * Setup, Usage and Data (ADMIN.md §2.8).
 */

import * as React from "react";
import { PageHeader } from "../../../ui/PageHeader.js";
import { PageTabs } from "../../components/PageTabs.js";
import { r } from "../../routes.js";

export type SyncTab = "sync-setup" | "sync-usage" | "sync-data";

export function SyncHeader({
  slug,
  tab,
  description,
  refetching,
}: {
  slug: string;
  tab: SyncTab;
  description?: React.ReactNode;
  refetching?: boolean;
}): React.ReactElement {
  return (
    <PageHeader
      title="Cloud Sync"
      description={description}
      refetching={refetching}
      tabs={
        <PageTabs
          label="Cloud Sync"
          value={tab}
          items={[
            { value: "sync-setup", label: "Setup", to: r.syncSetup(slug) },
            { value: "sync-usage", label: "Usage", to: r.syncUsage(slug) },
            { value: "sync-data", label: "Data", to: r.syncData(slug) },
          ]}
        />
      }
    />
  );
}
