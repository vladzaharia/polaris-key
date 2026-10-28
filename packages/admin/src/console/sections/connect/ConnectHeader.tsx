/**
 * The header Cloud Connect's pages share: one row in the sidebar, one h1, and route tabs for
 * Setup, Linked devices and Usage (ADMIN.md §2.8), as Cloud Sync's `SyncHeader`.
 */

import * as React from "react";
import { PageHeader } from "../../../ui/PageHeader.js";
import { PageTabs } from "../../components/PageTabs.js";
import { r } from "../../routes.js";

export type ConnectTab = "connect-setup" | "connect-devices" | "connect-usage";

export function ConnectHeader({
  slug,
  tab,
  description,
  refetching,
}: {
  slug: string;
  tab: ConnectTab;
  description?: React.ReactNode;
  refetching?: boolean;
}): React.ReactElement {
  const items = [
    { value: "connect-setup", label: "Setup", to: r.connectSetup(slug) },
    {
      value: "connect-devices",
      label: "Linked devices",
      to: r.connectDevices(slug),
    },
    { value: "connect-usage", label: "Usage", to: r.connectUsage(slug) },
  ];
  return (
    <PageHeader
      title="Cloud Connect"
      description={description}
      refetching={refetching}
      tabs={<PageTabs label="Cloud Connect" value={tab} items={items} />}
    />
  );
}
