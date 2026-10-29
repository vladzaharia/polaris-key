/**
 * Distribution → Commerce (A-17g; notes/S-14 §8.3, T2): **App Store products**. One row per
 * `app-store` commerce mapping (P6-01's `dist_store_products`: a store product id, the licence flag
 * a purchase grants, the deliverable), beside Apple's own state for that product id, read through
 * the pinned app (`GET …/connectors/asc/iap/products`).
 *
 * From here the operator creates the missing In-App Purchases (non-consumable, with their
 * localizations), adds a locale, sets the price from Apple's price points and makes a purchase
 * available. Every write is a named Worker control (A-17e) at its ADMIN.md §5.2 level, with one
 * `Idempotency-Key` per intent (`AscActionDialog`):
 *
 * - the first price is a plain confirm; changing an existing price is typed with the app's name
 *   and carries Apple's warning that an increase cannot be reverted;
 * - every availability write is typed (owner decision, 2026-10-04);
 * - the review screenshot and an app's first In-App Purchase submission are App Store Connect
 *   steps, deep-linked. Ready purchases ride the App Store page's submission.
 *
 * Product ids and prices are operator input and rows, never code (rule 5).
 */

import * as React from "react";
import type {
  AscIapProductDto,
  AscIapProductsResponse,
} from "../../../../api.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import {
  DataTable,
  type DataColumn,
  type RowActionItem,
} from "../../../../ui/data-table/index.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { PageHeader } from "../../../../ui/PageHeader.js";
import { Link } from "../../../router.js";
import { r } from "../../../routes.js";
import { CollectionTemplate } from "../../../templates/Collection.js";
import { useTableUrlState } from "../../../useTableUrlState.js";
import {
  ASC_LINKS,
  AscLink,
  appleIdOf,
  appleTone,
  appleWords,
  ascBlocked,
  ascConnector,
} from "../components/ascShared.js";
import { useConnectorRead, useConnectors } from "../data.js";
import { IapDialogs, type Pending } from "../components/IapDialogs.js";

/** The App Store connector's state and the product read: one hook for the page and the channel's Sales tab. */
export function useAppStoreProducts(slug: string) {
  const connectors = useConnectors(slug);
  const asc = ascConnector(connectors.data?.connectors);
  const blocked = connectors.data ? ascBlocked(asc) : null;
  const appleId = appleIdOf(asc);
  const ready = !!connectors.data && !blocked && !!appleId;
  const products = useConnectorRead<AscIapProductsResponse>(
    slug,
    "asc",
    "iap/products",
    {},
    { enabled: ready },
  );
  return { connectors, blocked, appleId, ready, products };
}

export function CommercePage({ slug }: { slug: string }): React.ReactElement {
  const state = useAppStoreProducts(slug);
  const { products } = state;
  return (
    <CollectionTemplate
      header={
        <PageHeader
          title="Commerce"
          refetching={products.isFetching && !products.isPending}
        />
      }
    >
      <AppStoreProductsBody slug={slug} state={state} />
    </CollectionTemplate>
  );
}

/** The App Store products, or why they can't be read yet. */
export function AppStoreProductsBody({
  slug,
  state,
}: {
  slug: string;
  state: ReturnType<typeof useAppStoreProducts>;
}): React.ReactElement {
  const { connectors, blocked, appleId, ready, products } = state;
  return connectors.isPending ? (
    <Skeleton className="h-64 w-full" />
  ) : connectors.isError ? (
    <ErrorState
      error={connectors.error}
      onRetry={() => void connectors.refetch()}
      context={{ area: "distribution", thing: "Store connectors" }}
    />
  ) : !ready ? (
    <EmptyState
      kind="first-run"
      headingLevel={2}
      title="App Store Connect can't be used for this product yet"
      description={blocked ?? "The connector names no app."}
      primaryAction={
        <Button variant="outline" asChild>
          <Link to={r.credentials(slug)}>Open Channel credentials</Link>
        </Button>
      }
      docs="/docs/features/commerce/"
    />
  ) : (
    <AppStoreProducts slug={slug} appleId={appleId!} q={products} />
  );
}

function AppStoreProducts({
  slug,
  appleId,
  q,
}: {
  slug: string;
  appleId: string;
  q: ReturnType<typeof useConnectorRead<AscIapProductsResponse>>;
}): React.ReactElement {
  const [state, setState] = useTableUrlState("app-store-products");
  const [pending, setPending] = React.useState<Pending | null>(null);
  const list = q.data?.products ?? [];

  const columns: DataColumn<AscIapProductDto>[] = [
    {
      id: "product",
      header: "Product id",
      accessorKey: "storeProductId",
      meta: { priority: 1, primary: true, mono: true },
    },
    {
      id: "status",
      header: "App Store",
      accessorFn: (p) => p.status,
      meta: { priority: 1 },
      cell: ({ row }) => <IapStatus p={row.original} />,
    },
    {
      id: "name",
      header: "Reference name",
      accessorFn: (p) => p.iap?.name ?? "",
      meta: { priority: 2 },
      cell: ({ row }) =>
        row.original.iap?.name ?? <span className="text-fg-subtle">—</span>,
    },
    {
      id: "flag",
      header: "Unlocks flag",
      accessorKey: "flag",
      meta: { priority: 2, mono: true },
    },
    {
      id: "deliverable",
      header: "Deliverable",
      accessorKey: "deliverableId",
      meta: { priority: 3, mono: true },
    },
  ];

  const rowActions = (p: AscIapProductDto): RowActionItem[] => {
    if (p.typeMismatch)
      return [
        {
          label: "Open in App Store Connect",
          onSelect: () =>
            window.open(
              ASC_LINKS.inAppPurchase(appleId, p.iap!.id),
              "_blank",
              "noreferrer",
            ),
        },
      ];
    if (!p.iap)
      return [
        {
          label: "Create in App Store…",
          onSelect: () => setPending({ kind: "create", product: p }),
        },
      ];
    return [
      {
        label: "Add or edit a locale…",
        onSelect: () => setPending({ kind: "localization", product: p }),
      },
      {
        label: "Set price…",
        onSelect: () => setPending({ kind: "price", product: p }),
      },
      {
        label: "Make available everywhere…",
        onSelect: () => setPending({ kind: "availability", product: p }),
      },
      { type: "separator" },
      {
        label: "Open in App Store Connect",
        onSelect: () =>
          window.open(
            ASC_LINKS.inAppPurchase(appleId, p.iap!.id),
            "_blank",
            "noreferrer",
          ),
      },
    ];
  };

  return (
    <section aria-labelledby="app-store-products" className="space-y-4">
      <h2
        id="app-store-products"
        className="text-base font-semibold text-fg-strong"
      >
        App Store products
      </h2>
      {q.data?.firstInAppPurchase ? (
        <Callout
          tone="info"
          title="The first In-App Purchase goes through App Store Connect"
        >
          <p>
            {q.data.firstInAppPurchaseNote}{" "}
            <AscLink href={ASC_LINKS.inAppPurchases(appleId)}>
              In-App Purchases
            </AscLink>
          </p>
        </Callout>
      ) : null}
      <DataTable<AscIapProductDto>
        id="app-store-products"
        caption="App Store products"
        data={list}
        columns={columns}
        getRowId={(p) => p.storeProductId}
        rowActions={rowActions}
        state={state}
        onStateChange={setState}
        search={{
          placeholder: "Search product ids",
          columns: ["product", "flag"],
        }}
        loading={q.isPending}
        error={q.isError && !q.data ? q.error : undefined}
        onRetry={() => void q.refetch()}
        exportCsv={false}
        mobile="cards"
        empty={
          <EmptyState
            kind="first-run"
            title="No App Store products are mapped"
            description="Commerce maps an App Store product id to the license flag a purchase unlocks. Once one is mapped, its In-App Purchase can be created here."
            docs="/docs/features/commerce/"
          />
        }
      />
      <p className="text-sm text-fg-muted">
        Ready purchases go to App Review with the next version from the{" "}
        <Link
          to={r.appStore(slug)}
          className="py-1 text-accent-fg underline underline-offset-4"
        >
          App Store
        </Link>{" "}
        page. The review screenshot is added in{" "}
        <AscLink href={ASC_LINKS.inAppPurchases(appleId)}>
          App Store Connect
        </AscLink>
        .
      </p>
      <IapDialogs
        slug={slug}
        pending={pending}
        warning={q.data?.priceChangeWarning ?? ""}
        onClose={() => setPending(null)}
      />
    </section>
  );
}

function IapStatus({ p }: { p: AscIapProductDto }): React.ReactElement {
  if (p.typeMismatch)
    return (
      <StatusPill tone="danger" size="sm">
        Another type in App Store Connect
      </StatusPill>
    );
  if (!p.iap)
    return (
      <StatusPill tone="neutral" size="sm">
        Not created
      </StatusPill>
    );
  return (
    <StatusPill tone={appleTone(p.status)} size="sm">
      {appleWords(p.status)}
    </StatusPill>
  );
}
