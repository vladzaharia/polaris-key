import * as React from "react";
import type {
  ConnectorStatusDto,
  ReleaseStoreResponse,
} from "../../../../api.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import {
  scopedConnectors,
  useScope,
  useScopeLoading,
} from "../model/channelScope.js";
import { ConnectorCard } from "./StoreControls.js";

/**
 * The store connector cards of Outlet credentials. A-20.7: a connector for a store outside the
 * product's scope is left out unless it is already set up.
 */
export function ConnectorGrid({
  slug,
  connectors,
  releases,
}: {
  slug: string;
  connectors: ConnectorStatusDto[];
  releases: ReleaseStoreResponse | undefined;
}): React.ReactElement {
  const scope = useScope(slug);
  const loading = useScopeLoading(slug);
  // The scope arrives with the product: until then no card shows, so none appears and vanishes.
  if (loading) return <Skeleton className="h-32 w-full" />;
  const shown = scopedConnectors(scope, connectors);
  if (shown.length === 0)
    return (
      <p className="text-sm text-fg-muted">
        No store connector fits this product&apos;s platforms.
      </p>
    );
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {shown.map((c) => (
        <ConnectorCard
          key={c.kind}
          slug={slug}
          connector={c}
          releases={releases}
        />
      ))}
    </div>
  );
}
