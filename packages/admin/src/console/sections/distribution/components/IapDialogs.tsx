/**
 * The App Store products' write dialogs (A-17g, moved out of `CommercePage` by A-22.6 so the page
 * and the channel's Sales tab share one page body): create the In-App Purchase, add a locale, set
 * or change the price, make it available. Each is a named Worker control at its ADMIN.md §5.2
 * level, with one `Idempotency-Key` per intent (`AscActionDialog`).
 */

import * as React from "react";
import { Plus, Trash2 } from "lucide-react";
import type {
  AscIapProductDto,
  AscPricePointsResponse,
} from "../../../../api.js";
import { Button } from "../../../../ui/Button.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { FormField } from "../../../../ui/form.js";
import { IconButton } from "../../../../ui/IconButton.js";
import { Input } from "../../../../ui/Input.js";
import { Select } from "../../../../ui/Select.js";
import { Switch } from "../../../../ui/Switch.js";
import { Textarea } from "../../../../ui/Textarea.js";
import { AscActionDialog, type AscIntent } from "./ascShared.js";
import { useConnectorRead } from "../data.js";
import {
  DESCRIPTION_MAX,
  iapLocalizationSeed,
  localizationsError,
  MAX_LOCALES,
  NAME_MAX,
  REFERENCE_MAX,
  type IapLocalization,
} from "../model/iapLocalization.js";

const TERRITORY = /^[A-Z]{3}$/;

const locBody = (l: IapLocalization) => ({
  locale: l.locale.trim(),
  name: l.name.trim(),
  ...(l.description.trim() ? { description: l.description.trim() } : {}),
});

export type Pending =
  | { kind: "create"; product: AscIapProductDto }
  | { kind: "localization"; product: AscIapProductDto }
  | { kind: "price"; product: AscIapProductDto }
  | { kind: "availability"; product: AscIapProductDto };

// ── The write dialogs ─────────────────────────────────────────────────────────────────────────

export function IapDialogs({
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
      confirmDisabledReason="Complete the purchase details to continue"
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
      confirmDisabledReason="Complete the locale to continue"
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
      confirmDisabledReason="Choose a price to continue"
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
