import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../../api.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { Button } from "../../../../ui/Button.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { SettingsRow } from "../../../templates/Settings.js";
import { Switch } from "../../../../ui/Switch.js";
import { toast } from "../../../../ui/toast.js";
import { mutate } from "../../../data/mutations.js";
import { qk } from "../../../data/queries.js";

export function PackageFeedsControl({
  slug,
  distributionOn,
  featureOn,
}: {
  slug: string;
  distributionOn: boolean;
  featureOn: boolean;
}): React.ReactElement {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: qk.packageFeedsSwitch(slug),
    queryFn: () => api.packageFeeds(slug),
    enabled: distributionOn,
  });
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
      <div className="border-t border-border px-5 py-3">
        <ErrorState
          compact
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      </div>
    );
  const blocked = !distributionOn || !featureOn;
  return (
    <>
      <SettingsRow
        label="Packages"
        htmlFor="feature-packages"
        help={
          blocked
            ? "Turn on Ship builds to manage packages."
            : on
              ? "Packages are available from this product’s registry."
              : "Packages are kept but no package feed answers installs or updates."
        }
        footer={
          failure && failureCopy ? (
            <div className="mt-2 flex items-center gap-3">
              <span className="text-xs text-danger">{failureCopy.title}</span>
              <Button size="sm" variant="outline" onClick={recover}>
                {failureCopy.action === "reload" ? "Reload" : "Retry"}
              </Button>
            </div>
          ) : undefined
        }
      >
        <Switch
          id="feature-packages"
          checked={on}
          disabled={blocked || query.isPending}
          readOnly={pending !== null}
          onCheckedChange={(next) => {
            if (next) void save(true).catch(() => undefined);
            else setConfirming(true);
          }}
        />
      </SettingsRow>
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
