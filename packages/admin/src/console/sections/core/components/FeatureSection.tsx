import * as React from "react";
import { ChevronRight } from "lucide-react";
import type {
  ServiceFeatureFacts,
  ServiceSlug,
  ServicesResponse,
} from "../../../../api.js";
import type {
  FeatureRow,
  FeatureSwitchRow,
} from "../../../../services.generated.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { REGISTRATION_LABELS } from "../../../../lib/labels.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { ServiceGlyph, serviceLabel } from "../../../../ui/ServiceBadge.js";
import { SourceBadge } from "../../../../ui/SourceBadge.js";
import { Switch } from "../../../../ui/Switch.js";
import { SettingsRow, SettingsSection } from "../../../templates/Settings.js";
import { Link } from "../../../router.js";
import { r } from "../../../routes.js";
import { CustomerPortalControl } from "./CustomerPortalControl.js";
import { PackageFeedsControl } from "./PackageFeedsControl.js";
import {
  codeMessage,
  factFor,
  featureChange,
  featureOn,
  featureSwitchId,
  listOf,
  serviceChange,
  unmetRequirements,
  type Enabled,
  type FailedChange,
  type ServiceChange,
} from "./serviceFeatures.js";

export function FeatureSection({
  feature,
  slug,
  enabled,
  facts,
  effectiveRegistration,
  busy,
  locked,
  source,
  error,
  codes,
  onRequestChange,
  onRetry,
}: {
  feature: FeatureRow;
  slug: string;
  enabled: Enabled;
  facts: ServiceFeatureFacts;
  effectiveRegistration: ServicesResponse["effectiveRegistration"];
  busy: boolean;
  /** The member cannot edit Core: every switch is inert, and the page says why once. */
  locked: boolean;
  source: "admin" | "manifest";
  error: FailedChange | null;
  codes: readonly string[];
  onRequestChange: (change: ServiceChange) => void;
  onRetry: () => void;
}): React.ReactElement {
  const on = featureOn(feature, enabled);
  const missing = on ? [] : unmetRequirements(feature.services, enabled);
  const blocked = !on && missing.length > 0;
  const sectionId = `feature-${feature.id}`;
  const requirementId = `${sectionId}-requirements`;
  const errorId = `${sectionId}-error`;
  const detailId = `${sectionId}-error-detail`;
  const fact = factFor(feature, facts);
  const errorMessages = codes.map(codeMessage);
  const copy = error && !errorMessages.length ? errorCopy(error.error) : null;
  // The switch that asked for the failed change: a service row when it requested only its own
  // service, the feature switch otherwise.
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
  const primaryErrorDescribedBy = failedRow ? undefined : errorDescribedBy;

  return (
    <div data-service={feature.accent}>
      <SettingsSection
        id={sectionId}
        title={feature.label}
        source={<SourceBadge source={source} path=".pkey/product" />}
        footer={
          error ? (
            <div className="border-t border-border px-5 py-3">
              {errorMessages.length ? (
                <Callout
                  tone="danger"
                  live
                  title={
                    <span id={errorId}>The server refused this change</span>
                  }
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
                    <Button size="sm" variant="outline" onClick={onRetry}>
                      Retry
                    </Button>
                  </div>
                </Callout>
              )}
            </div>
          ) : undefined
        }
      >
        <SettingsRow
          label={
            <span className="inline-flex items-center gap-2">
              <ServiceGlyph id={feature.services[0]!} />
              {feature.label}
            </span>
          }
          htmlFor={`${sectionId}-switch`}
          help={
            blocked ? (
              <TurnOnFirst id={requirementId} missing={missing} />
            ) : (
              "Turns this feature’s services on or off together."
            )
          }
        >
          <Switch
            id={`${sectionId}-switch`}
            checked={on}
            aria-disabled={blocked || locked || undefined}
            readOnly={busy || blocked || locked}
            aria-invalid={primaryErrorDescribedBy ? true : undefined}
            aria-describedby={describedBy(
              blocked ? requirementId : undefined,
              primaryErrorDescribedBy,
            )}
            onCheckedChange={(next) =>
              onRequestChange(featureChange(feature, next))
            }
          />
        </SettingsRow>

        {fact && on ? (
          <p className="border-t border-border px-5 py-3 text-sm text-fg-muted">
            {fact}
          </p>
        ) : null}

        {feature.switches.map((row) => (
          <FeatureSwitch
            key={row.id}
            row={row}
            feature={feature}
            slug={slug}
            enabled={enabled}
            featureOn={on}
            busy={busy || locked}
            errorDescribedBy={row === failedRow ? errorDescribedBy : undefined}
            onRequestChange={onRequestChange}
          />
        ))}

        <AdvancedFeatureState
          feature={feature}
          enabled={enabled}
          effectiveRegistration={effectiveRegistration}
        />
      </SettingsSection>
    </div>
  );
}

function FeatureSwitch({
  row,
  feature,
  slug,
  enabled,
  featureOn,
  busy,
  errorDescribedBy,
  onRequestChange,
}: {
  row: FeatureSwitchRow;
  feature: FeatureRow;
  slug: string;
  enabled: Enabled;
  featureOn: boolean;
  busy: boolean;
  /** The ids describing a failure of this row's own change; undefined when it did not fail. */
  errorDescribedBy: string | undefined;
  onRequestChange: (change: ServiceChange) => void;
}): React.ReactElement {
  // A new `FeatureSwitchId` is a type error until it has a case here: `default` only accepts
  // `never`.
  switch (row.id) {
    case "in-app-updates": {
      const service = row.service!;
      const on = enabled[service];
      const missing = on ? [] : unmetRequirements([service], enabled);
      const blocked = !on && missing.length > 0;
      const id = `feature-${feature.id}-${row.id}`;
      const requirementId = `${id}-requirements`;
      return (
        <div data-service={service}>
          <SettingsRow
            label={row.label}
            htmlFor={id}
            help={
              blocked ? (
                <TurnOnFirst id={requirementId} missing={missing} />
              ) : (
                "The Godot updater"
              )
            }
          >
            <Switch
              id={id}
              checked={on}
              aria-disabled={blocked || undefined}
              readOnly={busy || blocked}
              aria-invalid={errorDescribedBy ? true : undefined}
              aria-describedby={describedBy(
                blocked ? requirementId : undefined,
                errorDescribedBy,
              )}
              onCheckedChange={(next) =>
                onRequestChange(serviceChange(feature, row, next))
              }
            />
          </SettingsRow>
        </div>
      );
    }
    case "packages":
      return (
        <div data-service="distribution">
          <PackageFeedsControl
            slug={slug}
            distributionOn={enabled.distribution}
            featureOn={featureOn}
          />
        </div>
      );
    case "customer-portal":
      return (
        <div data-service="identity">
          <CustomerPortalControl slug={slug} />
        </div>
      );
    // Minted tokens have no separate mutable service state: recipes are declared in the release
    // manifest and approved in Edge mint.
    case "minted-tokens":
      return (
        <SettingsRow
          label={row.label}
          help={
            <>
              A recipe is the <code>mint</code> block of a minted-token entry in
              the catalog. It mints only after its signing secret is marked Edge
              mint and an operator approves it exactly as shown.
            </>
          }
        >
          <Link
            to={r.catalog(slug)}
            className="text-sm text-accent-fg underline underline-offset-2"
          >
            Review recipe
          </Link>
        </SettingsRow>
      );
    default:
      row.id satisfies never;
      return <></>;
  }
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
      className="rounded-sm text-left underline underline-offset-2 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus"
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

/** Space-separated `aria-describedby` from the ids that apply; undefined when none do. */
function describedBy(...ids: (string | undefined)[]): string | undefined {
  return ids.filter(Boolean).join(" ") || undefined;
}

function AdvancedFeatureState({
  feature,
  enabled,
  effectiveRegistration,
}: {
  feature: FeatureRow;
  enabled: Enabled;
  effectiveRegistration: ServicesResponse["effectiveRegistration"];
}): React.ReactElement {
  return (
    <details className="group border-t border-border px-5 py-3">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-sm text-sm text-fg-muted hover:text-fg-strong focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden
          className="size-4 transition-transform group-open:rotate-90"
        />
        Advanced
      </summary>
      <dl className="mt-3 space-y-2 text-sm">
        {feature.services.map((service) => (
          <div
            key={service}
            data-service={service}
            className="flex items-center justify-between gap-4"
          >
            <dt className="text-fg-muted">{serviceLabel(service)}</dt>
            <dd className="font-medium text-fg-strong">
              {enabled[service] ? "On" : "Off"}
            </dd>
          </div>
        ))}
        {feature.id === "licensing" ? (
          <div className="flex items-center justify-between gap-4">
            <dt className="text-fg-muted">Device registration</dt>
            <dd className="font-medium text-fg-strong">
              {REGISTRATION_LABELS[effectiveRegistration] ??
                effectiveRegistration}
            </dd>
          </div>
        ) : null}
      </dl>
    </details>
  );
}
