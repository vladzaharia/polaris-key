/**
 * Commerce → Overview (CM-29, plans/CM-29.md §3.4): which stores can sell, what they are mapped
 * to, and the latest purchases. Read-only; the mappings are edited on In-app purchases. The admin
 * API answers whatever Commerce's state, so a product with Commerce off still sees its history.
 */

import { channelLabel } from "@polaris-key/manifest";
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type CommerceStore, type CommerceView } from "../../../api.js";
import { fromSeconds, formatTableTime } from "../../../lib/format.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { PageHeader } from "../../../ui/PageHeader.js";
import { Skeleton } from "../../../ui/Skeleton.js";
import { StatusPill } from "../../../ui/StatusPill.js";
import { ScrollTable } from "../../../ui/ScrollTable.js";
import { useProduct } from "../../data/hooks.js";
import { qk } from "../../data/queries.js";
import { channelInScope, navFeaturesOf } from "../../nav.js";
import { Link } from "../../router.js";
import { r } from "../../routes.js";
import { SettingsSection } from "../../templates/Settings.js";
import {
  STOREFRONT_DOCS,
  SET_UP_STOREFRONT,
} from "../core/components/serviceFeatures.js";

/** `channel` is the catalogue channel the store sells through: the scope a row needs (A-20.7). */
const STORES: readonly {
  id: CommerceStore;
  channel: string;
  label: string;
}[] = [
  {
    id: "app-store",
    channel: "app-store",
    label: channelLabel("app-store"),
  },
  {
    id: "play",
    channel: "google-play",
    label: channelLabel("google-play"),
  },
  { id: "steam", channel: "steam", label: channelLabel("steam") },
];

const LINK = "py-1 text-accent-fg underline underline-offset-2";

/** The house vocabulary for what the server says about a store: no raw reasons. */
function storefrontState(
  s: CommerceView["setup"][CommerceStore],
): "ready" | "unset" | "credential" {
  if (s.configured) return "ready";
  return s.reason?.startsWith("no settings") ? "unset" : "credential";
}

const storeLabel = (id: string): string =>
  STORES.find((s) => s.id === id)?.label ?? id;

/** A store's sandbox or test purchases never count as sales: say so beside the product. */
function SandboxTag({
  environment,
}: {
  environment: string;
}): React.ReactElement | null {
  if (environment === "Production") return null;
  return (
    <span className="ms-2 rounded-sm border border-border px-1 text-xs text-fg-muted">
      {environment === "Sandbox" ? "Sandbox" : environment}
    </span>
  );
}

export function CommerceOverviewPage({
  slug,
}: {
  slug: string;
}): React.ReactElement {
  const product = useProduct(slug);
  const view = useQuery({
    queryKey: qk.commerceView(slug),
    queryFn: () => api.commerceView(slug),
  });
  const off = product.data?.services?.commerce?.enabled === false;

  let body: React.ReactNode;
  if (view.isPending) {
    // The page's own shape: two sections, no tabs and no header button.
    body = (
      <div
        className="space-y-6"
        role="status"
        aria-label="Loading the Commerce overview"
      >
        <Skeleton className="h-52 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  } else if (view.isError) {
    body = (
      <ErrorState error={view.error} onRetry={() => void view.refetch()} />
    );
  } else {
    const { setup, products, purchases } = view.data;
    // Only the stores the product's builds can reach; every store while the product loads.
    const features = navFeaturesOf(product.data);
    const inScope = STORES.filter((s) => channelInScope(features, s.channel));
    const ready = inScope.filter((s) => setup[s.id].configured).length;
    const rows = inScope.map((s) => ({
      ...s,
      state: storefrontState(setup[s.id]),
      mapped: products.filter((p) => p.store === s.id).length,
    }));
    const latest = purchases.slice(0, 10);
    body = (
      <div className="space-y-6">
        {off ? (
          <EmptyState
            kind="service-off"
            service="commerce"
            headingLevel={2}
            title="Commerce is off for this product"
            description="Purchases are not claimed and store refunds do not land. It needs Licensing."
            primaryAction={
              <Link to={r.services(slug)} className={LINK}>
                Open Features
              </Link>
            }
          />
        ) : null}

        <SettingsSection
          id="commerce-storefronts"
          title="Storefronts"
          description={
            ready === 0 ? (
              <a
                href={STOREFRONT_DOCS}
                target="_blank"
                rel="noreferrer"
                className={LINK}
              >
                {SET_UP_STOREFRONT} →
              </a>
            ) : (
              `${ready} ${ready === 1 ? "storefront" : "storefronts"} ready.`
            )
          }
        >
          <div className="px-5 py-4">
            <ul
              className="divide-y divide-border sm:hidden"
              aria-label="Storefronts"
            >
              {rows.map((s) => (
                <li key={s.id} className="space-y-1 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium">{s.label}</span>
                    <StatusPill domain="storefront" state={s.state} size="sm" />
                  </div>
                  <p className="text-sm text-fg-muted">
                    {s.mapped} mapped {s.mapped === 1 ? "product" : "products"}
                  </p>
                </li>
              ))}
            </ul>
            <div className="hidden sm:block">
              <ScrollTable
                label="Storefronts table"
                caption="Storefronts"
                className="w-full text-start text-sm"
              >
                <thead className="text-xs text-fg-muted">
                  <tr className="border-b border-border">
                    <th scope="col" className="py-2 pe-4 font-medium">
                      Store
                    </th>
                    <th scope="col" className="py-2 pe-4 font-medium">
                      Status
                    </th>
                    <th scope="col" className="py-2 text-end font-medium">
                      Mapped products
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((s) => (
                    <tr key={s.id}>
                      <th scope="row" className="py-2 pe-4 font-medium">
                        {s.label}
                      </th>
                      <td className="py-2 pe-4">
                        <StatusPill
                          domain="storefront"
                          state={s.state}
                          size="sm"
                        />
                      </td>
                      <td className="py-2 text-end tabular-nums">{s.mapped}</td>
                    </tr>
                  ))}
                </tbody>
              </ScrollTable>
            </div>
            {channelInScope(features, "app-store") ? (
              <p className="mt-3 text-sm text-fg-muted">
                <Link to={r.commerce(slug)} className={LINK}>
                  Map App Store products
                </Link>
              </p>
            ) : null}
          </div>
        </SettingsSection>

        <SettingsSection
          id="commerce-purchases"
          title="Recent purchases"
          description="Latest verified store purchases."
        >
          <div className="px-5 py-4">
            {latest.length === 0 ? (
              <p className="text-sm text-fg-muted">No purchases yet.</p>
            ) : (
              <>
                <ul
                  className="divide-y divide-border sm:hidden"
                  aria-label="Recent purchases"
                >
                  {latest.map((p) => (
                    <li
                      key={`${p.store}:${p.purchase}`}
                      className="space-y-1 py-3"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-medium">
                          {storeLabel(p.store)}
                        </span>
                        <StatusPill
                          domain="purchase"
                          state={p.state}
                          size="sm"
                        />
                      </div>
                      <p className="break-words font-mono text-xs text-fg-strong">
                        {p.storeProductId}
                        <SandboxTag environment={p.environment} />
                      </p>
                      <p className="text-sm text-fg-muted">
                        {formatTableTime(fromSeconds(p.lastVerified))}
                      </p>
                    </li>
                  ))}
                </ul>
                <div className="hidden sm:block">
                  <ScrollTable
                    label="Recent purchases table"
                    caption="Recent purchases"
                    className="w-full text-start text-sm"
                  >
                    <thead className="text-xs text-fg-muted">
                      <tr className="border-b border-border">
                        <th scope="col" className="py-2 pe-4 font-medium">
                          Store
                        </th>
                        <th scope="col" className="py-2 pe-4 font-medium">
                          Product
                        </th>
                        <th scope="col" className="py-2 pe-4 font-medium">
                          State
                        </th>
                        <th scope="col" className="py-2 text-end font-medium">
                          Verified
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {latest.map((p) => (
                        <tr key={`${p.store}:${p.purchase}`}>
                          <td className="py-2 pe-4">{storeLabel(p.store)}</td>
                          <td className="py-2 pe-4">
                            <code className="break-words font-mono text-xs text-fg-strong">
                              {p.storeProductId}
                            </code>
                            <SandboxTag environment={p.environment} />
                          </td>
                          <td className="py-2 pe-4">
                            <StatusPill
                              domain="purchase"
                              state={p.state}
                              size="sm"
                            />
                          </td>
                          <td className="py-2 text-end tabular-nums">
                            {formatTableTime(fromSeconds(p.lastVerified))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </ScrollTable>
                </div>
              </>
            )}
          </div>
        </SettingsSection>
      </div>
    );
  }

  return (
    <div className="space-y-6" data-template="record">
      <PageHeader
        title="Overview"
        refetching={view.isFetching && !view.isPending}
      />
      {body}
    </div>
  );
}
