/**
 * A channel's Sales tab (A-22.6): the commerce facet of the channel read model.
 *
 * - `commerce_off`: Commerce is off for the product; the reason and the way to turn it on.
 * - a store with a page of its own (`STORE_PANELS`, the built-in Polaris Locker): that panel.
 * - `not_set_up`: the storefront's human steps inline (the Prerequisites panel of Add to
 *   storefronts), with the full flow one link away.
 * - `ready` / `attention`: the store's own section (App Store products); a store with none yet
 *   points at the Commerce overview.
 */

import * as React from "react";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { useWriteGate } from "../../../access/useCan.js";
import { Link } from "../../../router.js";
import { r } from "../../../routes.js";
import { Prerequisites } from "../../storefronts/components/FlowPanels.js";
import { setUpHref } from "../../storefronts/pages/StorefrontsPage.js";
import { STORE_PANELS } from "../../storefronts/pages/StorePage.js";
import { useStorefronts } from "../../storefronts/data.js";
import {
  AppStoreProductsBody,
  useAppStoreProducts,
} from "../pages/CommercePage.js";
import type { ChannelRow } from "../../../../api.js";
import type { ChannelTabProps } from "./channelTabs.js";

/** The tab shows for a store Commerce sells through, or one with a page of its own. */
export function hasSales(c: ChannelRow): boolean {
  return c.commerce !== null || Object.hasOwn(STORE_PANELS, c.id);
}

export function ChannelSales({
  slug,
  name,
  channel,
}: ChannelTabProps): React.ReactElement | null {
  const facet = channel.commerce;
  if (facet?.reason === "commerce_off")
    return (
      <EmptyState
        kind="first-run"
        headingLevel={2}
        title="Commerce is off"
        description={`${name} can't sell through ${channel.label} until Commerce is on.`}
        primaryAction={
          <Button variant="outline" asChild>
            <Link to={r.services(slug)}>Open Services</Link>
          </Button>
        }
        docs="/docs/features/commerce/"
      />
    );
  if (Object.hasOwn(STORE_PANELS, channel.id)) {
    const Panel = STORE_PANELS[channel.id]!;
    return <Panel slug={slug} embedded />;
  }
  if (!facet) return null;
  if (facet.state === "not_set_up")
    return <SalesSetup slug={slug} channel={channel} />;
  return (
    <div className="space-y-6" data-sales={facet.state}>
      {facet.attention.some((a) => a.code === "identity_mismatch") ? (
        <Callout
          tone="warning"
          title={`${channel.label} app mismatch`}
          action={
            <Button size="sm" variant="outline" asChild>
              <Link to={r.commerceOverview(slug)}>Open Commerce</Link>
            </Button>
          }
        >
          <p>
            Purchases are checked against an app other than the assigned one.
          </p>
        </Callout>
      ) : null}
      {channel.id === "app-store" ? (
        <AppStoreSales slug={slug} />
      ) : (
        <EmptyState
          kind="first-run"
          headingLevel={2}
          title={`${channel.label} can sell`}
          description="Its purchases and the mappings behind them are on the Commerce overview."
          primaryAction={
            <Button variant="outline" asChild>
              <Link to={r.commerceOverview(slug)}>Open Commerce</Link>
            </Button>
          }
        />
      )}
    </div>
  );
}

function AppStoreSales({ slug }: { slug: string }): React.ReactElement {
  const state = useAppStoreProducts(slug);
  return <AppStoreProductsBody slug={slug} state={state} />;
}

/** The storefront's human steps, ticking themselves as Polaris Key sees them done. */
function SalesSetup({
  slug,
  channel,
}: {
  slug: string;
  channel: ChannelRow;
}): React.ReactElement {
  const q = useStorefronts(slug);
  const gate = useWriteGate("ship", slug);
  const store = q.data?.stores.find((s) => s.id === channel.id);
  return (
    <section
      aria-labelledby="channel-sales-setup"
      className="space-y-4"
      data-sales="not_set_up"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2
          id="channel-sales-setup"
          className="text-base font-semibold text-fg-strong"
        >
          Set up {channel.label}
        </h2>
        <Button asChild disabledReason={gate.disabledReason}>
          <Link to={setUpHref(slug, channel.id)}>Open full setup</Link>
        </Button>
      </div>
      {q.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : q.isError ? (
        <ErrorState
          error={q.error}
          onRetry={() => void q.refetch()}
          context={{ area: "distribution", thing: "Storefronts" }}
        />
      ) : store ? (
        <Prerequisites store={store} />
      ) : (
        <p className="text-sm text-fg-muted">
          {channel.label} has no setup steps here.
        </p>
      )}
    </section>
  );
}
