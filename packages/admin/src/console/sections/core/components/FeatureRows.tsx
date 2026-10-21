import * as React from "react";
import { CircleCheck, Circle, Lock } from "lucide-react";
import type { ServiceFeatureFacts, ServiceSlug } from "../../../../api.js";
import type {
  FeatureRow,
  FeatureSwitchRow,
} from "../../../../services.generated.js";
import { cn } from "../../../../lib/cn.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { Button } from "../../../../ui/Button.js";
import { CopyDetails } from "../../../../ui/CopyDetails.js";
import { Callout } from "../../../../ui/Callout.js";
import { ServiceGlyph } from "../../../../ui/ServiceBadge.js";
import { Switch } from "../../../../ui/Switch.js";
import { ReviewRecipeLink } from "../../config/components/RecipeState.js";
import { CustomerPortalControl } from "./CustomerPortalControl.js";
import { FeatureSubRow } from "./FeatureSubRow.js";
import { PackageFeedsControl } from "./PackageFeedsControl.js";
import { StorefrontListingControl } from "./StorefrontListingControl.js";
import {
  codeMessage,
  externalNeeds,
  factFor,
  featureChange,
  featureOn,
  featureSwitchId,
  featureWord,
  listOf,
  SET_UP_STOREFRONT,
  STOREFRONT_DOCS,
  serviceChange,
  storeRefundsAttention,
  unmetRequirements,
  type Enabled,
  type FailedChange,
  type PendingChange,
  type ServiceChange,
} from "./serviceFeatures.js";

/** Space-separated `aria-describedby` from the ids that apply; undefined when none do. */
function describedBy(...ids: (string | undefined)[]): string | undefined {
  return ids.filter(Boolean).join(" ") || undefined;
}

interface RowContext {
  slug: string;
  name: string;
  enabled: Enabled;
  facts: ServiceFeatureFacts;
  pending: PendingChange | null;
  failure: FailedChange | null;
  codes: readonly string[];
  /** Anything is saving: every switch is inert. */
  busy: boolean;
  /** The member cannot edit Core. */
  locked: boolean;
  onRequestChange: (change: ServiceChange) => void;
  onRetry: () => void;
}

/** "Turn on Sign-in first": a button that moves focus to the switch that fixes it. */
function TurnOnFirst({
  id,
  missing,
}: {
  id: string;
  missing: readonly ServiceSlug[];
}): React.ReactElement {
  return (
    <button
      id={id}
      type="button"
      className="rounded-sm text-left text-sm text-accent-fg underline underline-offset-2 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus"
      onClick={() => {
        const target = document.getElementById(featureSwitchId(missing[0]!));
        target?.scrollIntoView({ block: "center" });
        target?.focus();
      }}
    >
      Turn on {listOf(missing)} first
    </button>
  );
}

/** "Needs ✓ Licensing 🔒 Sign-in": each requirement with its own mark and a spoken state. */
function Needs({
  feature,
  enabled,
}: {
  feature: FeatureRow;
  enabled: Enabled;
}): React.ReactElement | null {
  const needs = externalNeeds(feature);
  if (needs.length === 0) return null;
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm text-fg-muted">
      <span>Needs</span>
      {needs.map((slug) => {
        const met = enabled[slug];
        const word = featureWord(slug);
        const Mark = met ? CircleCheck : Lock;
        return (
          <span
            key={slug}
            role="img"
            aria-label={`${word} is ${met ? "on" : "off"}`}
            className={cn(
              "inline-flex items-center gap-1",
              !met && "font-medium text-fg-strong",
            )}
          >
            <Mark
              aria-hidden
              className={cn("size-3.5", met && "text-success")}
            />
            {word}
          </span>
        );
      })}
    </p>
  );
}

function Status({
  on,
  text,
  blocked,
  requirementId,
  missing,
}: {
  on: boolean;
  text: string | null;
  blocked: boolean;
  requirementId: string;
  missing: readonly ServiceSlug[];
}): React.ReactElement {
  if (blocked) return <TurnOnFirst id={requirementId} missing={missing} />;
  if (!on)
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-fg-muted">
        <Circle aria-hidden className="size-4" />
        Off
      </span>
    );
  return (
    <span className="inline-flex items-start gap-1.5 text-sm tabular-nums text-success">
      <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0" />
      {text === SET_UP_STOREFRONT ? (
        <a
          href={STOREFRONT_DOCS}
          target="_blank"
          rel="noreferrer"
          className="text-accent-fg underline underline-offset-2 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus"
        >
          {text} →
        </a>
      ) : (
        <span className="text-fg-muted">{text ?? "On"}</span>
      )}
    </span>
  );
}

/** One feature: glyph tile, name and needs, status, switch, its own settings nested beneath. */
export function FeatureRowItem({
  feature,
  ctx,
}: {
  feature: FeatureRow;
  ctx: RowContext;
}): React.ReactElement {
  const { enabled, locked, busy, failure, codes } = ctx;
  const on = featureOn(feature, enabled);
  const missing = on ? [] : unmetRequirements(feature.services, enabled);
  const blocked = !on && missing.length > 0;
  const rowId = `feature-${feature.id}`;
  const requirementId = `${rowId}-requirements`;
  const errorId = `${rowId}-error`;
  const detailId = `${rowId}-error-detail`;
  const attention = storeRefundsAttention(feature, enabled, ctx.facts);
  const error = failure?.change.feature === feature.id ? failure : null;
  const errorMessages = error ? codes.map(codeMessage) : [];
  const copy = error && !errorMessages.length ? errorCopy(error.error) : null;
  const failedRow = error
    ? feature.switches.find(
        (row) =>
          row.kind === "service" &&
          error.change.requested.length === 1 &&
          error.change.requested[0] === row.service,
      )
    : undefined;
  const errorDescribedBy = error
    ? describedBy(
        errorId,
        errorMessages.length || copy?.description ? detailId : undefined,
      )
    : undefined;
  // The feature switch's own change carries the feature's label; a nested service switch's
  // carries its row's.
  const saving =
    ctx.pending?.phase === "write" &&
    ctx.pending.change.feature === feature.id &&
    ctx.pending.change.label === feature.label;
  const needs = externalNeeds(feature);

  return (
    <li
      data-service={feature.accent}
      id={rowId}
      className={cn(
        "grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-3 px-4 py-4",
        "sm:grid-cols-[auto_minmax(0,1fr)_minmax(0,18rem)_auto] sm:px-5",
        "@max-[20rem]:grid-cols-[minmax(0,1fr)_auto]",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "inline-flex size-8 items-center justify-center rounded-md border border-border bg-surface-sunken",
          // Large text on a phone: the name needs the width more than the glyph does.
          "@max-[20rem]:hidden",
          !on && "opacity-60",
        )}
      >
        <ServiceGlyph id={feature.services[0]!} />
      </span>
      <div className="min-w-0 space-y-0.5 @max-[20rem]:col-span-2">
        <p className="hyphens-manual break-words text-base font-medium text-fg-strong">
          {feature.label}
        </p>
        <Needs feature={feature} enabled={enabled} />
      </div>
      <div className="max-sm:col-span-2 max-sm:col-start-2 max-sm:row-start-2 @max-[20rem]:col-span-1 @max-[20rem]:col-start-1 @max-[20rem]:row-start-2">
        <Status
          on={on}
          text={factFor(feature, ctx.facts)}
          blocked={blocked}
          requirementId={requirementId}
          missing={missing}
        />
      </div>
      <Switch
        id={`${rowId}-switch`}
        className="@max-[20rem]:col-start-2 @max-[20rem]:row-start-2"
        touch
        aria-label={
          needs.length && blocked
            ? `${feature.label}, needs ${listOf(missing)}`
            : feature.label
        }
        checked={on}
        saving={saving}
        aria-disabled={blocked || locked || undefined}
        readOnly={busy || blocked || locked}
        aria-invalid={error && !failedRow ? true : undefined}
        aria-describedby={describedBy(
          blocked ? requirementId : undefined,
          failedRow ? undefined : errorDescribedBy,
        )}
        onCheckedChange={(next) =>
          ctx.onRequestChange(featureChange(feature, next))
        }
      />

      {attention ? (
        <div className="col-span-full">
          <Callout tone="warning" title={attention}>
            Purchases stay unlocked, but their refunds are missed until Commerce
            is on. Google Play stops retrying after 7 days.
          </Callout>
        </div>
      ) : null}

      {feature.switches.length > 0 || feature.id === "ship-builds" ? (
        <ul
          aria-label={`${feature.label} settings`}
          className="col-span-full divide-y divide-border overflow-hidden rounded-md border border-border bg-surface-sunken"
        >
          {feature.switches.map((row) => (
            <li key={row.id}>
              <SubSwitch
                row={row}
                feature={feature}
                ctx={ctx}
                featureOn={on}
                failedHere={row === failedRow}
                errorDescribedBy={
                  row === failedRow ? errorDescribedBy : undefined
                }
              />
            </li>
          ))}
          {feature.id === "ship-builds" ? (
            <li>
              <StorefrontListingControl
                slug={ctx.slug}
                name={ctx.name}
                locked={locked}
                blocked={!on}
              />
            </li>
          ) : null}
        </ul>
      ) : null}

      {error ? (
        <div className="col-span-full">
          {errorMessages.length ? (
            <Callout
              tone="danger"
              live
              title={<span id={errorId}>The server refused this change</span>}
            >
              <ul id={detailId} className="list-disc space-y-1 pl-5">
                {errorMessages.map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            </Callout>
          ) : (
            <Callout
              tone="danger"
              live
              title={<span id={errorId}>{copy!.title}</span>}
            >
              <div className="space-y-3">
                {copy!.description ? (
                  <p id={detailId}>{copy!.description}</p>
                ) : null}
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="outline" onClick={ctx.onRetry}>
                    Retry
                  </Button>
                  <CopyDetails copy={copy!} />
                </div>
              </div>
            </Callout>
          )}
        </div>
      ) : null}
    </li>
  );
}

function SubSwitch({
  row,
  feature,
  ctx,
  featureOn: parentOn,
  failedHere,
  errorDescribedBy,
}: {
  row: FeatureSwitchRow;
  feature: FeatureRow;
  ctx: RowContext;
  featureOn: boolean;
  failedHere: boolean;
  errorDescribedBy: string | undefined;
}): React.ReactElement {
  // A new `FeatureSwitchId` is a type error until it has a case here: `default` only accepts
  // `never`.
  switch (row.id) {
    case "in-app-updates": {
      const service = row.service!;
      const on = ctx.enabled[service];
      const missing = on ? [] : unmetRequirements([service], ctx.enabled);
      const blocked = !on && missing.length > 0;
      const waiting = !parentOn;
      const id = `feature-${feature.id}-${row.id}`;
      const requirementId = `${id}-requirements`;
      const saving =
        ctx.pending?.phase === "write" &&
        ctx.pending.change.requested.length === 1 &&
        ctx.pending.change.requested[0] === service;
      return (
        <div data-service={feature.accent}>
          <FeatureSubRow
            title={row.label}
            htmlFor={id}
            lockedBy={waiting ? feature.label : undefined}
            lockedId={requirementId}
            lines={[
              blocked ? (
                <TurnOnFirst id={requirementId} missing={missing} />
              ) : (
                "The Godot updater"
              ),
              "Store builds update through their store",
            ]}
            control={
              <Switch
                id={id}
                touch
                checked={on}
                saving={Boolean(saving)}
                aria-disabled={waiting || blocked || ctx.locked || undefined}
                readOnly={ctx.busy || waiting || blocked || ctx.locked}
                aria-invalid={failedHere ? true : undefined}
                aria-describedby={describedBy(
                  waiting || blocked ? requirementId : undefined,
                  errorDescribedBy,
                )}
                onCheckedChange={(next) =>
                  ctx.onRequestChange(serviceChange(feature, row, next))
                }
              />
            }
          />
        </div>
      );
    }
    case "packages":
      return (
        <div data-service={feature.accent}>
          <PackageFeedsControl
            slug={ctx.slug}
            distributionOn={ctx.enabled.distribution}
            featureOn={parentOn}
            locked={ctx.locked}
          />
        </div>
      );
    case "customer-portal":
      return (
        <div data-service={feature.accent}>
          <CustomerPortalControl
            slug={ctx.slug}
            blocked={!parentOn}
            locked={ctx.locked}
          />
        </div>
      );
    // Minted tokens have no separate mutable service state: recipes live on their catalog entries
    // and are approved there.
    case "minted-tokens":
      return (
        <FeatureSubRow
          title={row.label}
          lockedBy={parentOn ? undefined : feature.label}
          lines={["A recipe mints only after an operator approves it"]}
          control={
            parentOn ? (
              <ReviewRecipeLink slug={ctx.slug} />
            ) : (
              <span aria-disabled="true" className="text-sm text-fg-muted">
                Review recipe
              </span>
            )
          }
        />
      );
    default:
      row.id satisfies never;
      return <></>;
  }
}
