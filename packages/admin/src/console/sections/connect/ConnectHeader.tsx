/**
 * The header Cloud Connect's pages share: one row in the sidebar, one h1, and route tabs
 * (ADMIN.md §2.8), as Cloud Sync's `SyncHeader`. Only a built page gets a tab (D1): Setup now;
 * Linked devices waits on a Worker admin read of a product's linked devices, Usage on one of
 * relay usage. A lone tab is not drawn.
 */

import * as React from "react";
import { PageHeader } from "../../../ui/PageHeader.js";
import { PageTabs } from "../../components/PageTabs.js";
import { r } from "../../routes.js";

export type ConnectTab = "connect-setup";

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
  ];
  return (
    <PageHeader
      title="Cloud Connect"
      description={description}
      refetching={refetching}
      tabs={
        items.length > 1 ? (
          <PageTabs label="Cloud Connect" value={tab} items={items} />
        ) : undefined
      }
    />
  );
}
