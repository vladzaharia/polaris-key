/**
 * Distribute flow, steps 6 and 7: Preflight and Submit. Split out of `components/AscDistribute.tsx`.
 */

import * as React from "react";
import { StepTitle, type StepCtx } from "./AscStepShared.js";
import { RefreshCw } from "lucide-react";
import type {
  AscPreflightCheck,
  AscPreflightResponse,
  AscSubmissionItemsResponse,
  AscVersionDto,
} from "../../../../api.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { Checkbox } from "../../../../ui/Checkbox.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { SettingsRow } from "../../../templates/Settings.js";
import {
  ASC_LINKS,
  AscLink,
  PLATFORM_LABEL,
  appleTone,
  appleWords,
} from "./ascShared.js";
import { useConnectorRead } from "../data.js";

// ── Steps ─────────────────────────────────────────────────────────────────────────────────────

// ── 6. Preflight ──────────────────────────────────────────────────────────────────────────────

const CHECK_LABEL: Record<string, string> = {
  build: "Build",
  exportCompliance: "Export compliance",
  screenshots: "Screenshots",
  ageRating: "Age rating",
  reviewContact: "App Review contact",
  price: "Price",
  availability: "Availability",
  betaReviewDetails: "Beta review contact",
  betaLocalizations: "Beta test description",
  firstInAppPurchase: "First In-App Purchase",
  appPrivacy: "App Privacy",
};

function checkLink(id: string, appleId: string): string | null {
  switch (id) {
    case "screenshots":
    case "reviewContact":
      return ASC_LINKS.app(appleId);
    case "ageRating":
      return ASC_LINKS.appInformation(appleId);
    case "price":
    case "availability":
      return ASC_LINKS.pricing(appleId);
    case "betaReviewDetails":
    case "betaLocalizations":
      return ASC_LINKS.testInformation(appleId);
    case "firstInAppPurchase":
      return ASC_LINKS.inAppPurchases(appleId);
    case "appPrivacy":
      return ASC_LINKS.appPrivacy(appleId);
    default:
      return null;
  }
}

function checkPill(c: AscPreflightCheck): React.ReactElement {
  if (c.ok === true) return <StatusPill tone="success">Ready</StatusPill>;
  if (c.ok === null)
    return <StatusPill tone="neutral">Check in App Store Connect</StatusPill>;
  if (c.id.startsWith("beta"))
    return <StatusPill tone="warning">External testing only</StatusPill>;
  return <StatusPill tone="danger">Missing</StatusPill>;
}

export function PreflightStep({
  ctx,
  version,
}: {
  ctx: StepCtx;
  version: AscVersionDto;
}): React.ReactElement {
  const q = useConnectorRead<AscPreflightResponse>(
    ctx.slug,
    "asc",
    "distribute/preflight",
    { versionId: version.id },
  );
  return (
    <>
      <StepTitle
        description="What App Store Connect's API shows about this version's readiness."
        action={
          <Button
            size="sm"
            variant="outline"
            iconStart={<RefreshCw aria-hidden />}
            loading={q.isFetching}
            onClick={() => void q.refetch()}
          >
            Check again
          </Button>
        }
      >
        Preflight
      </StepTitle>
      {q.isPending ? (
        <div className="p-5">
          <Skeleton className="h-48 w-full" />
        </div>
      ) : q.isError ? (
        <div className="p-5">
          <ErrorState
            compact
            error={q.error}
            onRetry={() => void q.refetch()}
            context={{ area: "distribution", thing: "Preflight" }}
          />
        </div>
      ) : (
        <>
          <div className="px-5 pt-4">
            <Callout
              tone={q.data.ready ? "success" : "warning"}
              title={
                q.data.ready
                  ? "Nothing the API can see blocks the submission"
                  : "Fix the missing items before submitting"
              }
            >
              <p>
                Website-only items are yours to confirm in App Store Connect.
              </p>
            </Callout>
          </div>
          <div className="mt-4 divide-y divide-border border-t border-border">
            {q.data.checks.map((c) => {
              const link = checkLink(c.id, ctx.appleId);
              return (
                <SettingsRow
                  key={c.id}
                  label={CHECK_LABEL[c.id] ?? c.id}
                  help={
                    <>
                      {c.missing?.length ? (
                        <span className="block">
                          Missing: {c.missing.join(", ")}
                        </span>
                      ) : null}
                      {link && c.ok !== true ? (
                        <AscLink href={link}>Open in App Store Connect</AscLink>
                      ) : null}
                    </>
                  }
                >
                  {checkPill(c)}
                </SettingsRow>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}

// ── 7. Submit ─────────────────────────────────────────────────────────────────────────────────

export function SubmitStep({
  ctx,
  version,
  sent,
}: {
  ctx: StepCtx;
  version: AscVersionDto;
  sent: boolean;
}): React.ReactElement {
  const platform = version.platform ?? "IOS";
  const q = useConnectorRead<AscSubmissionItemsResponse>(
    ctx.slug,
    "asc",
    "distribute/submission-items",
    { platform },
  );
  const [skip, setSkip] = React.useState<string[]>([]);
  const iaps = q.data?.inAppPurchaseVersions ?? [];
  const assets = q.data?.backgroundAssetVersions ?? [];
  const toggle = (id: string, on: boolean) =>
    setSkip((s) => (on ? s.filter((x) => x !== id) : [...s, id]));
  const iapIds = iaps
    .map((i) => i.inAppPurchaseVersionId)
    .filter((id) => !skip.includes(id));
  const assetIds = assets
    .map((a) => a.backgroundAssetVersionId)
    .filter((id) => !skip.includes(id));
  return (
    <>
      <StepTitle description="The version and the items you tick go to App Review together.">
        Submit for review
      </StepTitle>
      <SettingsRow
        label="Version"
        help={`${version.versionString} (${PLATFORM_LABEL[platform] ?? platform})`}
      >
        <StatusPill tone={appleTone(version.state)}>
          {appleWords(version.state)}
        </StatusPill>
      </SettingsRow>
      <div className="space-y-4 border-t border-border p-5">
        {q.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : q.isError ? (
          <ErrorState
            compact
            error={q.error}
            onRetry={() => void q.refetch()}
            context={{ area: "distribution", thing: "Submission items" }}
          />
        ) : (
          <>
            {q.data.firstInAppPurchase ? (
              <Callout
                tone="info"
                title="The first In-App Purchase goes through App Store Connect"
              >
                <p>
                  {q.data.firstInAppPurchaseNote}{" "}
                  <AscLink href={ASC_LINKS.inAppPurchases(ctx.appleId)}>
                    In-App Purchases
                  </AscLink>
                </p>
              </Callout>
            ) : null}
            {iaps.length || assets.length ? (
              <fieldset className="space-y-3">
                <legend className="text-sm font-semibold text-fg-strong">
                  Also submit
                </legend>
                {iaps.map((i) => (
                  <Checkbox
                    key={i.inAppPurchaseVersionId}
                    checked={!skip.includes(i.inAppPurchaseVersionId)}
                    onCheckedChange={(on) =>
                      toggle(i.inAppPurchaseVersionId, on)
                    }
                    label={`In-App Purchase ${i.name ?? i.productId}`}
                    description={`${i.productId} · ${appleWords(i.state)}`}
                  />
                ))}
                {assets.map((a) => (
                  <Checkbox
                    key={a.backgroundAssetVersionId}
                    checked={!skip.includes(a.backgroundAssetVersionId)}
                    onCheckedChange={(on) =>
                      toggle(a.backgroundAssetVersionId, on)
                    }
                    label={`Background Asset ${a.assetPackIdentifier ?? a.backgroundAssetVersionId}`}
                    description={`Version ${a.version ?? "?"} · ${appleWords(a.appStoreReleaseState)}`}
                  />
                ))}
              </fieldset>
            ) : (
              <p className="text-sm text-fg-muted">
                No In-App Purchase or Background Asset is ready to go with this
                version.
              </p>
            )}
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border px-5 py-4">
        {sent ? <StatusPill tone="info">With App Review</StatusPill> : null}
        <Button
          variant="danger"
          disabledReason={
            ctx.gate ??
            (sent
              ? "This version is already with App Review."
              : !version.buildId
                ? "Attach a build in Version first."
                : undefined)
          }
          onClick={() =>
            ctx.open({
              action: "connector.submitReview",
              control: "distribute/submit",
              title: `Submit version ${version.versionString} for App Review?`,
              consequences: [
                `App Store Connect sends version ${version.versionString}${
                  iapIds.length + assetIds.length
                    ? ` and ${iapIds.length + assetIds.length} more item${iapIds.length + assetIds.length === 1 ? "" : "s"}`
                    : ""
                } to App Review.`,
                "While it waits for review you can cancel the submission; once Apple approves it, the release option decides when it goes live.",
                "Type the app's name to confirm.",
              ],
              confirmLabel: "Submit for review",
              body: {
                versionId: version.id,
                ...(iapIds.length ? { inAppPurchaseVersionIds: iapIds } : {}),
                ...(assetIds.length
                  ? { backgroundAssetVersionIds: assetIds }
                  : {}),
              },
              done: `Submitted ${version.versionString} for App Review`,
            })
          }
        >
          Submit for review…
        </Button>
      </div>
    </>
  );
}
