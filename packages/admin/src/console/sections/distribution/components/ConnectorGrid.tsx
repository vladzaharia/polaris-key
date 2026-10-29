import * as React from "react";
import { channelForOutlet } from "@polaris-key/manifest";
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

/** The connectors that drive a channel's outlets. */
export function connectorsFor<C extends { outletKinds: string[] }>(
  connectors: readonly C[],
  channelId: string,
): C[] {
  return connectors.filter((c) =>
    c.outletKinds.some((k) => channelForOutlet(k)?.id === channelId),
  );
}

/**
 * The store connector cards. Without `channelId` (A-20.7), every connector in the product's scope
 * or already set up. With it (A-22.3b, a channel's Setup), only the connectors that drive that
 * channel's outlets, and nothing at all when none does.
 */
export function ConnectorGrid({
  slug,
  connectors,
  releases,
  channelId,
}: {
  slug: string;
  connectors: ConnectorStatusDto[];
  releases: ReleaseStoreResponse | undefined;
  channelId?: string;
}): React.ReactElement | null {
  const scope = useScope(slug);
  const loading = useScopeLoading(slug);
  // The scope arrives with the product: until then no card shows, so none appears and vanishes.
  // A channel's own cards need no scope: the page already knows the channel is in scope.
  if (loading && !channelId) return <Skeleton className="h-32 w-full" />;
  const shown = channelId
    ? connectorsFor(connectors, channelId)
    : scopedConnectors(scope, connectors);
  if (shown.length === 0 && channelId) return null;
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
