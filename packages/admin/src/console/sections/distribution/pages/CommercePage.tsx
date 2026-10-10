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
import { Plus, Trash2 } from "lucide-react";
import type {
  AscIapProductDto,
  AscIapProductsResponse,
  AscPricePointsResponse,
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
import { FormField } from "../../../../ui/form.js";
import { IconButton } from "../../../../ui/IconButton.js";
import { Input } from "../../../../ui/Input.js";
import { Select } from "../../../../ui/Select.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { Switch } from "../../../../ui/Switch.js";
import { Textarea } from "../../../../ui/Textarea.js";
import { PageHeader } from "../../../../ui/PageHeader.js";
import { Link } from "../../../router.js";
import { r } from "../../../routes.js";
import { CollectionTemplate } from "../../../templates/Collection.js";
import { useTableUrlState } from "../../../useTableUrlState.js";
import {
  ASC_LINKS,
  AscActionDialog,
  AscLink,
  appleIdOf,
  appleTone,
  appleWords,
  ascBlocked,
  ascConnector,
  type AscIntent,
} from "../components/ascShared.js";
import { useConnectorRead, useConnectors } from "../data.js";

/** Apple's limits (A-17e): reference name 64, display name 35, description 55, ≤ 10 locales. */
const REFERENCE_MAX = 64;
const NAME_MAX = 35;
const DESCRIPTION_MAX = 55;
const MAX_LOCALES = 10;
const LOCALE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/;
const TERRITORY = /^[A-Z]{3}$/;

/** One locale of an In-App Purchase: its display name and description in the store. */
export interface IapLocalization {
  locale: string;
  name: string;
  description: string;
}

/**
 * The starting localizations of a new In-App Purchase.
 *
 * THE SEAM FOR A-18b (notes/S-15 §7.5): App Store products default their display name and
 * description from the shared listing model's locales. Until A-18b lands there is no model to read,
 * so a new purchase starts with one empty row in the app's primary language.
 */
export function iapLocalizationSeed(
  _product: AscIapProductDto,
): IapLocalization[] {
  return [{ locale: "en-US", name: "", description: "" }];
}

/** Why a set of localizations cannot be sent, or `null`. */
export function localizationsError(locs: IapLocalization[]): string | null {
  if (locs.length === 0) return "Add at least one locale.";
  if (locs.length > MAX_LOCALES) return `Use at most ${MAX_LOCALES} locales.`;
  const seen = new Set<string>();
  for (const l of locs) {
    const locale = l.locale.trim();
    if (!LOCALE.test(locale))
      return `"${l.locale}" isn't a locale code such as en-US.`;
    if (seen.has(locale)) return `${locale} appears twice.`;
    seen.add(locale);
    if (l.name.trim() === "") return `Name the purchase in ${locale}.`;
    if (l.name.trim().length > NAME_MAX)
      return `The ${locale} name is longer than ${NAME_MAX} characters.`;
    if (l.description.trim().length > DESCRIPTION_MAX)
      return `The ${locale} description is longer than ${DESCRIPTION_MAX} characters.`;
  }
  return null;
}

const locBody = (l: IapLocalization) => ({
  locale: l.locale.trim(),
  name: l.name.trim(),
  ...(l.description.trim() ? { description: l.description.trim() } : {}),
});

type Pending =
  | { kind: "create"; product: AscIapProductDto }
  | { kind: "localization"; product: AscIapProductDto }
  | { kind: "price"; product: AscIapProductDto }
  | { kind: "availability"; product: AscIapProductDto };

export function CommercePage({ slug }: { slug: string }): React.ReactElement {
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

  return (
    <CollectionTemplate
      header={
        <PageHeader
          title="Commerce"
          refetching={products.isFetching && !products.isPending}
        />
      }
    >
      {connectors.isPending ? (
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
              <Link to={r.credentials(slug)}>Open Outlet credentials</Link>
            </Button>
          }
          docs="/docs/services/distribution/commerce/"
        />
      ) : (
        <AppStoreProducts slug={slug} appleId={appleId!} q={products} />
      )}
    </CollectionTemplate>
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
      header: "Grants flag",
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
            description="Commerce maps an App Store product id to the licence flag a purchase unlocks. Once one is mapped, its In-App Purchase can be created here."
            docs="/docs/services/distribution/commerce/"
          />
        }
      />
      <p className="text-sm text-fg-muted">
        Ready purchases go to App Review with the next version from the{" "}
        <Link
          to={r.appStore(slug)}
          className="text-accent-fg underline underline-offset-4"
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

// ── The write dialogs ─────────────────────────────────────────────────────────────────────────

function IapDialogs({
  slug,
  pending,
  warning,
  onClose,
}: {
  slug: string;
  pending: Pending | null;
  warning: string;
  onClose: () => void;
}): React.ReactElement | null {
  if (!pending) return null;
  const key = `${pending.kind}:${pending.product.storeProductId}`;
  switch (pending.kind) {
    case "create":
      return (
        <CreateDialog
          key={key}
          slug={slug}
          product={pending.product}
          onClose={onClose}
        />
      );
    case "localization":
      return (
        <LocalizationDialog
          key={key}
          slug={slug}
          product={pending.product}
          onClose={onClose}
        />
      );
    case "price":
      return (
        <PriceDialog
          key={key}
          slug={slug}
          product={pending.product}
          warning={warning}
          onClose={onClose}
        />
      );
    case "availability":
      return (
        <AscActionDialog
          key={key}
          slug={slug}
          onClose={onClose}
          intent={{
            action: "connector.iapAvailability",
            control: "iap/availability",
            title: `Make ${pending.product.storeProductId} available everywhere?`,
            consequences: [
              "App Store Connect sells the In-App Purchase in every territory, and in new territories as Apple adds them.",
              "An availability already set in App Store Connect is kept as it is.",
              "Type the app's name to confirm: availability decides where the purchase is sold.",
            ],
            confirmLabel: "Make available",
            body: { productId: pending.product.storeProductId },
            done: `${pending.product.storeProductId} is available in every territory`,
          }}
        />
      );
  }
}

function LocalizationRows({
  value,
  onChange,
  single = false,
}: {
  value: IapLocalization[];
  onChange: (v: IapLocalization[]) => void;
  single?: boolean;
}): React.ReactElement {
  const update = (i: number, patch: Partial<IapLocalization>) =>
    onChange(value.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <div className="space-y-3">
      {value.map((l, i) => (
        <div
          key={i}
          className="grid grid-cols-1 gap-3 rounded-md border border-border p-3 sm:grid-cols-[7rem_minmax(0,1fr)_auto]"
        >
          <FormField<string>
            name={`iap-locale-${i}`}
            label="Locale"
            value={l.locale}
            onChange={(v) => update(i, { locale: v })}
          >
            {(field) => (
              <Input
                id={field.id}
                mono
                value={l.locale}
                autoComplete="off"
                spellCheck={false}
                onValueChange={(v) => update(i, { locale: v })}
                aria-describedby={field["aria-describedby"]}
              />
            )}
          </FormField>
          <div className="space-y-3">
            <FormField<string>
              name={`iap-name-${i}`}
              label="Display name"
              help={`${l.name.length} / ${NAME_MAX}`}
              value={l.name}
              onChange={(v) => update(i, { name: v })}
            >
              {(field) => (
                <Input
                  id={field.id}
                  value={l.name}
                  maxLength={NAME_MAX}
                  onValueChange={(v) => update(i, { name: v })}
                  aria-describedby={field["aria-describedby"]}
                />
              )}
            </FormField>
            <FormField<string>
              name={`iap-description-${i}`}
              label="Description"
              optional
              help={`${l.description.length} / ${DESCRIPTION_MAX}`}
              value={l.description}
              onChange={(v) => update(i, { description: v })}
            >
              {(field) => (
                <Input
                  id={field.id}
                  value={l.description}
                  maxLength={DESCRIPTION_MAX}
                  onValueChange={(v) => update(i, { description: v })}
                  aria-describedby={field["aria-describedby"]}
                />
              )}
            </FormField>
          </div>
          {single ? null : (
            <div className="flex items-start justify-end sm:pt-6">
              <IconButton
                label={`Remove ${l.locale || "this locale"}`}
                icon={<Trash2 aria-hidden />}
                disabled={value.length === 1}
                onClick={() => onChange(value.filter((_, j) => j !== i))}
              />
            </div>
          )}
        </div>
      ))}
      {single || value.length >= MAX_LOCALES ? null : (
        <Button
          size="sm"
          variant="outline"
          iconStart={<Plus aria-hidden />}
          onClick={() =>
            onChange([...value, { locale: "", name: "", description: "" }])
          }
        >
          Add locale
        </Button>
      )}
    </div>
  );
}

function CreateDialog({
  slug,
  product,
  onClose,
}: {
  slug: string;
  product: AscIapProductDto;
  onClose: () => void;
}): React.ReactElement {
  const id = product.storeProductId;
  const [referenceName, setReferenceName] = React.useState(
    id.slice(0, REFERENCE_MAX),
  );
  const [reviewNote, setReviewNote] = React.useState("");
  const [family, setFamily] = React.useState(false);
  const [locs, setLocs] = React.useState(() => iapLocalizationSeed(product));
  const problem =
    referenceName.trim() === ""
      ? "Enter a reference name."
      : localizationsError(locs);
  const intent = React.useMemo<AscIntent>(
    () => ({
      action: "connector.iapCreate",
      control: "iap/create",
      title: `Create ${id} in App Store Connect?`,
      consequences: [
        "App Store Connect creates a non-consumable In-App Purchase with this product id, under this product's app.",
        "A product id can't be reused in App Store Connect once created.",
        "Set its price and availability afterwards; then it goes to App Review with a version.",
      ],
      confirmLabel: "Create In-App Purchase",
      body: { productId: id },
      done: `Created ${id} in App Store Connect`,
    }),
    [id],
  );
  return (
    <AscActionDialog
      slug={slug}
      intent={intent}
      onClose={onClose}
      confirmDisabled={problem !== null}
      bodyExtra={() => ({
        referenceName: referenceName.trim(),
        ...(reviewNote.trim() ? { reviewNote: reviewNote.trim() } : {}),
        familySharable: family,
        localizations: locs.map(locBody),
      })}
    >
      <div className="space-y-4">
        <FormField<string>
          name="iap-reference-name"
          label="Reference name"
          help="Shown only in App Store Connect and its reports."
          required
          value={referenceName}
          onChange={setReferenceName}
        >
          {(field) => (
            <Input
              id={field.id}
              value={referenceName}
              maxLength={REFERENCE_MAX}
              onValueChange={setReferenceName}
              aria-describedby={field["aria-describedby"]}
            />
          )}
        </FormField>
        <LocalizationRows value={locs} onChange={setLocs} />
        <FormField<string>
          name="iap-review-note"
          label="Note for App Review"
          optional
          value={reviewNote}
          onChange={setReviewNote}
        >
          {(field) => (
            <Textarea
              id={field.id}
              rows={2}
              value={reviewNote}
              onValueChange={setReviewNote}
              aria-describedby={field["aria-describedby"]}
            />
          )}
        </FormField>
        <Switch
          checked={family}
          onCheckedChange={setFamily}
          label="Family Sharing"
          description="Family members can use the purchase too. Once on, it can't be turned off."
        />
        {problem ? (
          <p className="text-sm text-fg-muted" aria-live="polite">
            {problem}
          </p>
        ) : null}
      </div>
    </AscActionDialog>
  );
}

function LocalizationDialog({
  slug,
  product,
  onClose,
}: {
  slug: string;
  product: AscIapProductDto;
  onClose: () => void;
}): React.ReactElement {
  const id = product.storeProductId;
  const [locs, setLocs] = React.useState(() =>
    iapLocalizationSeed(product).slice(0, 1),
  );
  const problem = localizationsError(locs);
  const intent = React.useMemo<AscIntent>(
    () => ({
      action: "connector.iapLocalization",
      control: "iap/localization",
      title: `Add or edit a locale of ${id}?`,
      consequences: [
        "App Store Connect shows this name and description for the purchase in that locale.",
        "An existing locale is replaced.",
      ],
      confirmLabel: "Save locale",
      body: { productId: id },
      done: `Saved the locale of ${id}`,
    }),
    [id],
  );
  return (
    <AscActionDialog
      slug={slug}
      intent={intent}
      onClose={onClose}
      confirmDisabled={problem !== null}
      bodyExtra={() => locBody(locs[0]!)}
    >
      <LocalizationRows value={locs} onChange={setLocs} single />
    </AscActionDialog>
  );
}

function PriceDialog({
  slug,
  product,
  warning,
  onClose,
}: {
  slug: string;
  product: AscIapProductDto;
  warning: string;
  onClose: () => void;
}): React.ReactElement {
  const id = product.storeProductId;
  const [territory, setTerritory] = React.useState("USA");
  const [point, setPoint] = React.useState<string | null>(null);
  const valid = TERRITORY.test(territory);
  const points = useConnectorRead<AscPricePointsResponse>(
    slug,
    "asc",
    "iap/price-points",
    { productId: id, territory },
    { enabled: valid },
  );
  const change = points.data?.priceChange === true;
  const current = points.data?.current;
  const chosen = points.data?.pricePoints.find((p) => p.id === point);
  const intent = React.useMemo<AscIntent>(
    () =>
      change
        ? {
            action: "connector.iapPriceChange",
            control: "iap/price",
            title: `Change the price of ${id}?`,
            consequences: [
              `The price now is ${current?.customerPrice ?? "?"} (${current?.baseTerritory ?? "?"}). The new price takes effect at once, and Apple derives every other territory from it.`,
              warning,
              "Type the app's name to confirm.",
            ],
            confirmLabel: "Change price",
            body: { productId: id },
            done: `Changed the price of ${id}`,
          }
        : {
            action: "connector.iapPrice",
            control: "iap/price",
            title: `Set the price of ${id}?`,
            consequences: [
              "The price takes effect at once in the base territory, and Apple derives every other territory from it.",
              "Changing it later needs the app's name typed to confirm.",
            ],
            confirmLabel: "Set price",
            body: { productId: id },
            done: `Set the price of ${id}`,
          },
    [change, id, current?.customerPrice, current?.baseTerritory, warning],
  );
  return (
    <AscActionDialog
      slug={slug}
      intent={intent}
      onClose={onClose}
      confirmDisabled={!valid || !chosen}
      bodyExtra={() => ({ baseTerritory: territory, pricePointId: point })}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[8rem_minmax(0,1fr)]">
        <FormField<string>
          name="iap-territory"
          label="Base territory"
          error={valid ? undefined : "Use a three-letter code such as USA."}
          value={territory}
          onChange={setTerritory}
        >
          {(field) => (
            <Input
              id={field.id}
              mono
              value={territory}
              maxLength={3}
              autoComplete="off"
              onValueChange={(v) => {
                setTerritory(v.toUpperCase());
                setPoint(null);
              }}
              aria-describedby={field["aria-describedby"]}
            />
          )}
        </FormField>
        <FormField<string | null>
          name="iap-price-point"
          label="Price"
          required
          help={
            current
              ? `Now ${current.customerPrice ?? "?"} (${current.baseTerritory ?? "?"}).`
              : "No price is set yet."
          }
          value={point}
          onChange={setPoint}
        >
          {(field) =>
            points.isError ? (
              <ErrorState
                compact
                error={points.error}
                onRetry={() => void points.refetch()}
                context={{ area: "distribution", thing: "Price points" }}
              />
            ) : (
              <Select
                id={field.id}
                value={point}
                onChange={setPoint}
                disabled={!points.data}
                placeholder={
                  points.isPending ? "Loading prices…" : "Choose a price"
                }
                options={(points.data?.pricePoints ?? []).map((p) => ({
                  value: p.id,
                  label: p.customerPrice ?? p.id,
                  description: p.proceeds
                    ? `Proceeds ${p.proceeds}`
                    : undefined,
                }))}
                aria-describedby={field["aria-describedby"]}
              />
            )
          }
        </FormField>
      </div>
    </AscActionDialog>
  );
}
