import * as React from "react";
import { ChevronRight } from "lucide-react";
import type { ServiceFeatureFacts, ServicesResponse } from "../../../../api.js";
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
import { CustomerPortalControl } from "./CustomerPortalControl.js";
import { PackageFeedsControl } from "./PackageFeedsControl.js";
import {
  codeMessage,
  factFor,
  featureChange,
  featureOn,
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
  const fact = factFor(feature, facts);
  const errorMessages = codes.map(codeMessage);

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
                <Callout tone="danger" title="The server refused this change">
                  <ul className="list-disc space-y-1 pl-5">
                    {errorMessages.map((message) => (
                      <li key={message}>{message}</li>
                    ))}
                  </ul>
                </Callout>
              ) : (
                <Callout tone="danger" title={errorCopy(error.error).title}>
                  <div className="space-y-3">
                    {errorCopy(error.error).description ? (
                      <p>{errorCopy(error.error).description}</p>
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
            blocked
              ? `Needs ${listOf(missing)} to be on first.`
              : "Turns this feature’s services on or off together."
          }
        >
          <Switch
            id={`${sectionId}-switch`}
            checked={on}
            disabled={blocked}
            readOnly={busy}
            aria-invalid={errorMessages.length ? true : undefined}
            onCheckedChange={(next) =>
              onRequestChange(featureChange(feature, next))
            }
          />
        </SettingsRow>

        {fact ? (
          <p
            role="status"
            className="border-t border-border px-5 py-3 text-sm text-fg-muted"
          >
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
            busy={busy}
            facts={facts}
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
  facts,
  onRequestChange,
}: {
  row: FeatureSwitchRow;
  feature: FeatureRow;
  slug: string;
  enabled: Enabled;
  featureOn: boolean;
  busy: boolean;
  facts: ServiceFeatureFacts;
  onRequestChange: (change: ServiceChange) => void;
}): React.ReactElement {
  if (row.kind === "service") {
    const service = row.service!;
    const on = enabled[service];
    const missing = on ? [] : unmetRequirements([service], enabled);
    const blocked = !on && missing.length > 0;
    const id = `feature-${feature.id}-${row.id}`;
    return (
      <div data-service={service}>
        <SettingsRow
          label={row.label}
          htmlFor={id}
          help={
            blocked
              ? `Needs ${listOf(missing)} to be on first.`
              : "Controls this service independently of the feature switch."
          }
        >
          <Switch
            id={id}
            checked={on}
            disabled={blocked}
            readOnly={busy}
            onCheckedChange={(next) =>
              onRequestChange(serviceChange(feature, row, next))
            }
          />
        </SettingsRow>
      </div>
    );
  }

  if (row.id === "packages") {
    return (
      <div data-service="distribution">
        <PackageFeedsControl
          slug={slug}
          distributionOn={enabled.distribution}
          featureOn={featureOn}
        />
      </div>
    );
  }

  if (row.id === "customer-portal") {
    return (
      <div data-service="identity">
        <CustomerPortalControl slug={slug} />
      </div>
    );
  }

  // The generator makes a new fact id a type error until it lands here. Minted tokens have no
  // separate mutable service state: their catalog state is the feature fact.
  if (row.id === "minted-tokens") {
    const version = facts.managedConfig.catalogVersion;
    return (
      <SettingsRow
        label={row.label}
        help="Minted tokens are declared and approved in Catalog."
      >
        <span role="status" className="text-sm text-fg-muted">
          {version === null
            ? "No published catalog"
            : `Catalog v${version} published`}
        </span>
      </SettingsRow>
    );
  }

  return <></>;
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
