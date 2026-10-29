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
import { useQuery } from "@tanstack/react-query";
import { Check, Circle } from "lucide-react";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { useWriteGate } from "../../../access/useCan.js";
import { Link } from "../../../router.js";
import { Panel } from "../../../templates/Dashboard.js";
import { globalPage, r } from "../../../routes.js";
import { setUpHref } from "../../storefronts/pages/StorefrontsPage.js";
import { STORE_PANELS } from "../../storefronts/pages/StorePage.js";
import { useStorefronts } from "../../storefronts/data.js";
import {
  AppStoreProductsBody,
  useAppStoreProducts,
} from "../pages/CommercePage.js";
import type {
  ChannelRow,
  CommerceStore,
  CommerceView,
} from "../../../../api.js";
import { commerceReads } from "../../commerce/data.js";
import type { ChannelTabProps } from "./channelTabs.js";

/** The tab shows for a store Commerce sells through, or one with a page of its own. */
export function hasSales(c: ChannelRow): boolean {
  return c.commerce !== null || Object.hasOwn(STORE_PANELS, c.id);
}

/** The Commerce read's store for a channel; a channel without one has no per-store facts. */
const COMMERCE_STORE: Readonly<Record<string, CommerceStore>> = {
  "app-store": "app-store",
  "google-play": "play",
  steam: "steam",
};

export function ChannelSales({
  slug,
  name,
  channel,
}: ChannelTabProps): React.ReactElement | null {
  const facet = channel.commerce;
  if (facet?.reason === "commerce_off")
    return (
      <EmptyState
        kind="service-off"
        service="commerce"
        headingLevel={2}
        title="Commerce is off for this product"
        description={`${name} can't sell through ${channel.label} until Commerce is on.`}
        primaryAction={
          <Button variant="outline" asChild>
            <Link to={r.services(slug)}>Open Features</Link>
          </Button>
        }
      />
    );
  if (Object.hasOwn(STORE_PANELS, channel.id)) {
    const Store = STORE_PANELS[channel.id]!;
    return <Store slug={slug} embedded />;
  }
  if (!facet) return null;
  if (facet.state === "not_set_up")
    return <SalesSetup slug={slug} channel={channel} />;
  return <SalesReady slug={slug} name={name} channel={channel} />;
}

function SalesReady({
  slug,
  name,
  channel,
}: ChannelTabProps): React.ReactElement {
  const store = COMMERCE_STORE[channel.id];
  const view = useQuery({
    ...commerceReads.view(slug),
    enabled: store !== undefined,
  });
  const mismatch = channel.commerce?.attention.some(
    (a) => a.code === "identity_mismatch",
  );
  const id = store ? view.data?.identity?.[store] : undefined;
  return (
    <div className="space-y-6" data-sales={channel.commerce?.state}>
      {mismatch ? (
        <Callout
          tone="warning"
          title={`${channel.label} app mismatch`}
          action={
            <Button size="sm" variant="outline" asChild>
              <Link to={r.commerceOverview(slug)}>Fix on Commerce</Link>
            </Button>
          }
        >
          <p>
            {id?.value && id.assigned
              ? `Purchases are checked against ${id.value}, not ${name}'s app ${id.assigned}.`
              : `Purchases are checked against an app other than ${name}'s.`}
          </p>
        </Callout>
      ) : null}
      {channel.id === "app-store" ? (
        <AppStoreSales slug={slug} />
      ) : store ? (
        <StoreFacts
          slug={slug}
          label={channel.label}
          store={store}
          view={view}
        />
      ) : null}
    </div>
  );
}

/** What the Commerce read serves for a store without a section of its own. */
function StoreFacts({
  slug,
  label,
  store,
  view,
}: {
  slug: string;
  label: string;
  store: CommerceStore;
  view: ReturnType<typeof useQuery<CommerceView>>;
}): React.ReactElement {
  if (view.isPending) return <Skeleton className="h-32 w-full" />;
  if (view.isError || !view.data)
    return (
      <ErrorState
        error={view.error}
        onRetry={() => void view.refetch()}
        context={{ area: "commerce", thing: "Commerce" }}
      />
    );
  const products = view.data.products.filter((p) => p.store === store);
  const purchases = view.data.purchases.filter((p) => p.store === store);
  const id = view.data.identity[store];
  const facts: [string, React.ReactNode][] = [
    ["Products on sale", products.length],
    ["Purchases", purchases.length],
    [
      "App",
      id?.value ? (
        <code className="break-all font-mono text-xs">{id.value}</code>
      ) : (
        "Not set"
      ),
    ],
  ];
  return (
    <Panel
      title={`${label} sales`}
      headingLevel={2}
      action={
        <Button size="sm" variant="outline" asChild>
          <Link to={r.commerceOverview(slug)}>See purchases</Link>
        </Button>
      }
    >
      <dl className="divide-y divide-border text-sm">
        {facts.map(([k, v]) => (
          <div
            key={k}
            className="flex flex-wrap items-baseline justify-between gap-x-3 py-2"
          >
            <dt className="text-fg-muted">{k}</dt>
            <dd className="min-w-0 text-end text-fg-strong">{v}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}

function AppStoreSales({ slug }: { slug: string }): React.ReactElement {
  const state = useAppStoreProducts(slug);
  return <AppStoreProductsBody slug={slug} state={state} inChannel />;
}

/**
 * The storefront's human steps (commerce.sales-wizard): a count, steps not started in a neutral
 * ring, and the first open step's action as the one filled button.
 */
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
  const steps = store?.prerequisites ?? [];
  const done = steps.filter((x) => x.state === "met").length;
  const first = steps.find((x) => x.state !== "met");
  return (
    <section
      aria-labelledby="channel-sales-setup"
      className="space-y-4"
      data-sales="not_set_up"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2
          id="channel-sales-setup"
          className="text-base font-semibold text-fg-strong"
        >
          Set up
        </h2>
        {steps.length ? (
          <p className="text-sm text-fg-muted" aria-live="polite">
            {done} of {steps.length} done
          </p>
        ) : null}
      </div>
      {q.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : q.isError ? (
        <ErrorState
          error={q.error}
          onRetry={() => void q.refetch()}
          context={{ area: "distribution", thing: "Storefronts" }}
        />
      ) : steps.length === 0 ? (
        <p className="text-sm text-fg-muted">
          {channel.label} has no setup steps here.
        </p>
      ) : (
        <ol
          aria-label={`${channel.label} steps`}
          className="divide-y divide-border rounded-lg border border-border bg-surface-raised px-4"
        >
          {steps.map((x) => (
            <li
              key={x.id}
              data-state={x.state}
              className="flex min-h-12 flex-wrap items-center justify-between gap-x-3 gap-y-2 py-2"
            >
              <div className="flex min-w-0 items-start gap-2">
                {x.state === "met" ? (
                  <Check aria-hidden className="mt-0.5 size-4 text-success" />
                ) : (
                  <Circle aria-hidden className="mt-0.5 size-4 text-fg-muted" />
                )}
                <div className="min-w-0">
                  <p className="text-sm font-medium text-fg-strong">
                    {x.label}
                    <span className="sr-only">
                      {x.state === "met" ? ": done" : ": to do"}
                    </span>
                  </p>
                  {x.detail ? (
                    <p className="text-sm text-fg-muted">{x.detail}</p>
                  ) : null}
                </div>
              </div>
              {x === first && x.page ? (
                <Button asChild disabledReason={gate.disabledReason}>
                  <Link to={globalPage("platform-stores")}>
                    Open Connections
                  </Link>
                </Button>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      <p className="text-sm">
        <Link
          to={setUpHref(slug, channel.id)}
          className="py-1 text-accent-fg underline underline-offset-4"
        >
          Open full setup
        </Link>
      </p>
    </section>
  );
}
