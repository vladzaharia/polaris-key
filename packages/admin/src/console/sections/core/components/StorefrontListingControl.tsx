import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type PolarisKeyListed } from "../../../../api.js";
import { confirmFor } from "../../../../lib/actions.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { Button } from "../../../../ui/Button.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
import { SegmentedControl } from "../../../../ui/SegmentedControl.js";
import { Spinner } from "../../../../ui/Spinner.js";
import { toast } from "../../../../ui/toast.js";
import { mutate } from "../../../data/mutations.js";
import { qk } from "../../../data/queries.js";
import { FeatureSubRow } from "./FeatureSubRow.js";

type Reach = "unlisted" | "eligible" | "everyone";

const OPTIONS = [
  { value: "unlisted", label: "Unlisted" },
  { value: "eligible", label: "Eligible" },
  { value: "everyone", label: "Everyone" },
] as const;

/** The Polaris Locker listing as one choice: who finds the product on Discover. */
export function reachOf(
  listed: PolarisKeyListed | undefined,
  audience: "eligible" | "everyone" | undefined,
): Reach {
  if (listed === "unlisted") return "unlisted";
  return audience === "everyone" ? "everyone" : "eligible";
}

export function StorefrontListingControl({
  slug,
  name,
  locked,
  blocked = false,
}: {
  slug: string;
  name: string;
  locked: boolean;
  /** Ship builds is off: the row stays, disabled. */
  blocked?: boolean;
}): React.ReactElement | null {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: qk.portal(slug),
    queryFn: () => api.portalSettings(slug).then((r) => r.settings),
  });
  const [confirming, setConfirming] = React.useState<Reach | null>(null);
  const [pending, setPending] = React.useState(false);
  const [failure, setFailure] = React.useState<{
    error: unknown;
    to: Reach;
  } | null>(null);
  if (query.isError) return null;
  const listed = query.data?.storeListed ?? "auto";
  const current = reachOf(listed, query.data?.storeAudience);

  const save = async (to: Reach): Promise<void> => {
    setFailure(null);
    setPending(true);
    try {
      const result = await mutate("updatePortalSettings", slug, {
        ...(to === "unlisted"
          ? { storeListed: "unlisted" as const }
          : {
              ...(listed === "unlisted"
                ? { storeListed: "auto" as const }
                : {}),
              storeAudience: to,
              ...(to === "everyone"
                ? { confirm: "storefront.polarisKey.audience" as const }
                : {}),
            }),
      });
      queryClient.setQueryData(qk.portal(slug), result.settings);
      toast.success(
        `Polaris Locker listing: ${OPTIONS.find((o) => o.value === to)!.label}`,
      );
    } catch (error) {
      setFailure({ error, to });
      throw error;
    } finally {
      setPending(false);
    }
  };

  const request = (to: Reach): void => {
    if (to === current) return;
    if (to === "eligible") void save(to).catch(() => undefined);
    else setConfirming(to);
  };
  const policy = confirmFor(
    confirming === "everyone"
      ? "storefront.audienceEveryone"
      : "storefront.listing",
  );
  const failed = failure ? errorCopy(failure.error) : null;
  const id = "feature-locker-listing";

  return (
    <>
      <FeatureSubRow
        stack
        lockedBy={blocked ? "Ship builds" : undefined}
        lockedId={`${id}-requirements`}
        title={<span id={`${id}-label`}>Polaris Locker listing</span>}
        lines={[
          `Who finds ${name} on Discover`,
          "Eligible: owns it or qualifies",
        ]}
        footer={
          failure && failed ? (
            <div className="mt-2 flex items-center gap-3">
              <span
                id={`${id}-error`}
                role="alert"
                className="text-xs text-danger"
              >
                {failed.title}
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void save(failure.to).catch(() => undefined)}
              >
                Retry
              </Button>
            </div>
          ) : undefined
        }
        control={
          <span className="inline-flex min-w-0 max-w-full items-center gap-2">
            {pending ? <Spinner label="" /> : null}
            <SegmentedControl
              size="sm"
              wrap
              aria-labelledby={`${id}-label`}
              options={OPTIONS}
              value={current}
              aria-describedby={
                blocked
                  ? `${id}-requirements`
                  : failure
                    ? `${id}-error`
                    : undefined
              }
              disabled={blocked || locked || pending || query.isPending}
              onChange={request}
            />
          </span>
        }
      />
      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        intent={policy.intent === "none" ? "neutral" : policy.intent}
        title={
          confirming === "everyone"
            ? "Show this product to everyone signed in?"
            : "Take this product off Discover?"
        }
        consequences={
          confirming === "everyone"
            ? [
                "Every signed-in person sees it on Discover, including people who cannot add it.",
                "Someone who cannot add it gets a link to its store pages or website, never Add.",
              ]
            : [
                "Nobody finds it on Discover.",
                "Licenses already added keep working.",
              ]
        }
        confirmLabel={confirming === "everyone" ? "Show to everyone" : "Unlist"}
        typedConfirmation={
          policy.typedConfirmation
            ? { value: slug, label: "Type the product slug" }
            : undefined
        }
        describeError={(e) =>
          errorCopy(e, { area: "distribution", thing: "The listing" })
        }
        onConfirm={async () => {
          if (confirming) await save(confirming);
        }}
      />
    </>
  );
}
