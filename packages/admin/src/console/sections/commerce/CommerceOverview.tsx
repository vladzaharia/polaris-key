/**
 * Commerce → Overview (CM-29, plans/CM-29.md §3.4): which stores can sell, what they are mapped
 * to, and the latest purchases. Read-only; the mappings are edited on In-app purchases. The admin
 * API answers whatever Commerce's state, so a product with Commerce off still sees its history.
 */

import { channelLabel } from "@polaris-key/manifest";
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  api,
  type CommerceStore,
  type CommerceStoreIdentity,
  type CommerceView,
} from "../../../api.js";
import { fromSeconds, formatTableTime } from "../../../lib/format.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { PageHeader } from "../../../ui/PageHeader.js";
import { Skeleton } from "../../../ui/Skeleton.js";
import { StatusPill } from "../../../ui/StatusPill.js";
import { ScrollTable } from "../../../ui/ScrollTable.js";
import { useProduct } from "../../data/hooks.js";
import { qk } from "../../data/queries.js";
import { Link } from "../../router.js";
import { r } from "../../routes.js";
import { SettingsSection } from "../../templates/Settings.js";
import {
  IdentityAttention,
  StoreIdentityCell,
  type StoreIdentityRow,
} from "./StoreIdentity.js";
import {
  STOREFRONT_DOCS,
  SET_UP_STOREFRONT,
} from "../core/components/serviceFeatures.js";

const STORES: readonly { id: CommerceStore; label: string }[] = [
  { id: "app-store", label: channelLabel("app-store") },
  { id: "play", label: channelLabel("google-play") },
  { id: "steam", label: channelLabel("steam") },
];

const LINK = "py-1 text-accent-fg underline underline-offset-2";

/** The house vocabulary for what the server says about a store: no raw reasons. */
function storefrontState(
  s: CommerceView["setup"][CommerceStore],
  identity?: CommerceStoreIdentity,
): "ready" | "unset" | "credential" | "mismatch" {
  // A typed app that differs from the assigned one is what the callout says; the status agrees.
  if (identity?.mismatch) return "mismatch";
  if (s.configured) return "ready";
  // No settings, or settings with no app to sell for: not set up. Anything else is the key.
  const r = s.reason ?? "";
  return r.startsWith("no settings") ||
    r === "no_app_assigned" ||
    r === "own_credential_unpinned"
    ? "unset"
    : "credential";
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
    const ready = STORES.filter((s) => setup[s.id].configured).length;
    const rows = STORES.map((s) => ({
      ...s,
      state: storefrontState(setup[s.id], view.data.identity?.[s.id]),
      mapped: products.filter((p) => p.store === s.id).length,
      identityRow: {
        id: s.id,
        label: s.label,
        identity: view.data.identity?.[s.id],
        reason: setup[s.id].reason,
      } satisfies StoreIdentityRow,
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
          <div className="space-y-4 px-5 py-4">
            {off ? null : (
              <IdentityAttention
                slug={slug}
                rows={rows.map((s) => s.identityRow)}
              />
            )}
            <ul
              className="divide-y divide-border sm:hidden"
              aria-label="Storefronts"
            >
              {rows.map((s) => (
                <li key={s.id} className="space-y-1 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <span
                      tabIndex={-1}
                      data-store-row={s.id}
                      className="font-medium"
                    >
                      {s.label}
                    </span>
                    <StatusPill domain="storefront" state={s.state} size="sm" />
                  </div>
                  <StoreIdentityCell slug={slug} row={s.identityRow} />
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
                    <th
                      scope="col"
                      className="py-2 text-start pe-4 font-medium"
                    >
                      Store
                    </th>
                    <th
                      scope="col"
                      className="py-2 text-start pe-4 font-medium"
                    >
                      App
                    </th>
                    <th
                      scope="col"
                      className="py-2 text-start pe-4 font-medium"
                    >
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
                      <th
                        scope="row"
                        tabIndex={-1}
                        data-store-row={s.id}
                        className="py-2 text-start pe-4 font-medium"
                      >
                        {s.label}
                      </th>
                      <td className="py-2 pe-4">
                        <StoreIdentityCell slug={slug} row={s.identityRow} />
                      </td>
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
            <p className="text-sm text-fg-muted">
              <Link to={r.commerce(slug)} className={LINK}>
                Map App Store products
              </Link>
            </p>
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
                        <th
                          scope="col"
                          className="py-2 text-start pe-4 font-medium"
                        >
                          Store
                        </th>
                        <th
                          scope="col"
                          className="py-2 text-start pe-4 font-medium"
                        >
                          Product
                        </th>
                        <th
                          scope="col"
                          className="py-2 text-start pe-4 font-medium"
                        >
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
