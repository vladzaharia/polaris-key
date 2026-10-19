/**
 * Commerce → Overview (CM-29, plans/CM-29.md §3.4): which stores can sell, what they are mapped
 * to, and the latest purchases. Read-only; the mappings are edited on In-app purchases. The admin
 * API answers whatever Commerce's state, so a product with Commerce off still sees its history.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type CommerceStore } from "../../../api.js";
import { fromSeconds, formatTableTime } from "../../../lib/format.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { PageHeader } from "../../../ui/PageHeader.js";
import { PageSkeleton } from "../../../ui/Skeleton.js";
import { ScrollTable } from "../../../ui/ScrollTable.js";
import { useProduct } from "../../data/hooks.js";
import { qk } from "../../data/queries.js";
import { Link } from "../../router.js";
import { r } from "../../routes.js";
import { SettingsSection } from "../../templates/Settings.js";

const STORES: readonly { id: CommerceStore; label: string }[] = [
  { id: "app-store", label: "App Store" },
  { id: "play", label: "Google Play" },
  { id: "steam", label: "Steam" },
];

/** "no settings for this store" → "No settings for this store". */
const sentence = (reason: string | null): string =>
  reason ? reason.charAt(0).toUpperCase() + reason.slice(1) : "Not set up";

const LINK = "text-accent-fg underline underline-offset-2";

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
    body = <PageSkeleton template="record" label="Commerce overview" />;
  } else if (view.isError) {
    body = (
      <ErrorState error={view.error} onRetry={() => void view.refetch()} />
    );
  } else {
    const { setup, products, purchases } = view.data;
    const ready = STORES.filter((s) => setup[s.id].configured).length;
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
                Open Services
              </Link>
            }
          />
        ) : null}

        <SettingsSection
          id="commerce-storefronts"
          title="Storefronts"
          description={
            ready === 0
              ? "Set up a storefront to sell through a store."
              : `${ready} ${ready === 1 ? "storefront" : "storefronts"} ready.`
          }
        >
          <div className="px-5 py-4">
            <ScrollTable
              label="Storefronts table"
              caption="Storefronts"
              className="w-full text-left text-sm"
            >
              <thead className="text-xs text-fg-muted">
                <tr className="border-b border-border">
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Store
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Status
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    Mapped products
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {STORES.map((s) => (
                  <tr key={s.id}>
                    <th scope="row" className="py-2 pr-4 font-medium">
                      {s.label}
                    </th>
                    <td className="py-2 pr-4">
                      {setup[s.id].configured
                        ? "Ready"
                        : sentence(setup[s.id].reason)}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {products.filter((p) => p.store === s.id).length}
                    </td>
                  </tr>
                ))}
              </tbody>
            </ScrollTable>
            <p className="mt-3 text-sm text-fg-muted">
              <Link to={r.commerce(slug)} className={LINK}>
                Map App Store products
              </Link>
            </p>
          </div>
        </SettingsSection>

        <SettingsSection
          id="commerce-purchases"
          title="Recent purchases"
          description="The latest store purchases this product verified."
        >
          <div className="px-5 py-4">
            {purchases.length === 0 ? (
              <p className="text-sm text-fg-muted">No purchases yet.</p>
            ) : (
              <ScrollTable
                label="Recent purchases table"
                caption="Recent purchases"
                className="w-full text-left text-sm"
              >
                <thead className="text-xs text-fg-muted">
                  <tr className="border-b border-border">
                    <th scope="col" className="py-2 pr-4 font-medium">
                      Store
                    </th>
                    <th scope="col" className="py-2 pr-4 font-medium">
                      Product
                    </th>
                    <th scope="col" className="py-2 pr-4 font-medium">
                      State
                    </th>
                    <th scope="col" className="py-2 text-right font-medium">
                      Verified
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {purchases.slice(0, 10).map((p) => (
                    <tr key={`${p.store}:${p.purchase}`}>
                      <td className="py-2 pr-4">
                        {STORES.find((s) => s.id === p.store)?.label ?? p.store}
                      </td>
                      <td className="py-2 pr-4">
                        <code className="font-mono text-xs text-fg-strong break-all">
                          {p.storeProductId}
                        </code>
                      </td>
                      <td className="py-2 pr-4">{p.state}</td>
                      <td className="py-2 text-right tabular-nums">
                        {formatTableTime(fromSeconds(p.lastVerified))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </ScrollTable>
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
