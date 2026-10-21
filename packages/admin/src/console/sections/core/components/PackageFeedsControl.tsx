import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../../api.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { Button } from "../../../../ui/Button.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { FeatureSubRow } from "./FeatureSubRow.js";
import { Switch } from "../../../../ui/Switch.js";
import { toast } from "../../../../ui/toast.js";
import { mutate } from "../../../data/mutations.js";
import { qk } from "../../../data/queries.js";
import { useFeedsOverview } from "../../feeds/data.js";

export function PackageFeedsControl({
  slug,
  distributionOn,
  featureOn,
  locked = false,
}: {
  slug: string;
  distributionOn: boolean;
  featureOn: boolean;
  /** The member cannot edit Core. */
  locked?: boolean;
}): React.ReactElement {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: qk.packageFeedsSwitch(slug),
    queryFn: () => api.packageFeeds(slug),
    enabled: distributionOn,
  });
  const overview = useFeedsOverview(
    { kind: "product", slug },
    distributionOn && featureOn,
  );
  const registryHost = overview.data?.registryOrigin
    ? new URL(overview.data.registryOrigin).host
    : undefined;
  const [pending, setPending] = React.useState<boolean | null>(null);
  const [confirming, setConfirming] = React.useState(false);
  const [failure, setFailure] = React.useState<{
    error: unknown;
    requested: boolean;
  } | null>(null);
  const latest = React.useRef(query.data?.packageFeeds);
  latest.current = query.data?.packageFeeds;
  const on = pending ?? query.data?.packageFeeds?.enabled ?? false;
  const save = async (next: boolean): Promise<void> => {
    setFailure(null);
    setPending(next);
    try {
      const result = await mutate("savePackageFeeds", slug, {
        enabled: next,
        expectedVersion: latest.current?.version ?? 0,
      });
      queryClient.setQueryData(qk.packageFeedsSwitch(slug), {
        packageFeeds: result.packageFeeds,
      });
      latest.current = result.packageFeeds;
      toast.success(`Packages turned ${next ? "on" : "off"}`, {
        action: {
          label: "Undo",
          onClick: () => void save(!next).catch(() => undefined),
        },
      });
    } catch (failure) {
      setFailure({ error: failure, requested: next });
      throw failure;
    } finally {
      setPending(null);
    }
  };
  const failureCopy = failure ? errorCopy(failure.error) : null;
  const recover = (): void => {
    if (!failure) return;
    if (failureCopy?.action === "reload") {
      void query.refetch().then((result) => {
        if (!result.isError) setFailure(null);
      });
      return;
    }
    void save(failure.requested).catch(() => undefined);
  };
  if (query.isError)
    return (
      <div className="px-4 py-3">
        <ErrorState
          compact
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      </div>
    );
  const blocked = !distributionOn || !featureOn;
  const switchId = "feature-packages";
  const requirementId = `${switchId}-requirements`;
  const errorId = `${switchId}-error`;
  const describedBy =
    [blocked ? requirementId : null, failureCopy ? errorId : null]
      .filter(Boolean)
      .join(" ") || undefined;
  return (
    <>
      <FeatureSubRow
        title="Packages"
        htmlFor={switchId}
        lockedBy={blocked ? "Ship builds" : undefined}
        lockedId={requirementId}
        lines={[
          on ? (
            registryHost ? (
              <>
                On <span className="font-mono">{registryHost}</span>
              </>
            ) : (
              "On this product’s registry"
            )
          ) : (
            "Off: no package feed answers installs or updates"
          ),
        ]}
        footer={
          failure && failureCopy ? (
            <div className="mt-2 flex items-center gap-3">
              <span id={errorId} role="alert" className="text-xs text-danger">
                {failureCopy.title}
              </span>
              <Button size="sm" variant="outline" onClick={recover}>
                {failureCopy.action === "reload" ? "Reload" : "Retry"}
              </Button>
            </div>
          ) : undefined
        }
        control={
          <Switch
            id={switchId}
            touch
            checked={on}
            saving={pending !== null}
            disabled={blocked || locked || query.isPending}
            aria-describedby={describedBy}
            onCheckedChange={(next) => {
              if (next) void save(true).catch(() => undefined);
              else setConfirming(true);
            }}
          />
        }
      />
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        intent="caution"
        title="Turn off Packages?"
        consequences={[
          "Every package feed answers not-found within 30 seconds: installs and updates from it fail.",
          "Packages and their settings are kept and answer again when turned on.",
        ]}
        confirmLabel="Turn off Packages"
        describeError={errorCopy}
        onConfirm={() => save(false)}
      />
    </>
  );
}
