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

export function CustomerPortalControl({
  slug,
  blocked = false,
  locked = false,
}: {
  slug: string;
  /** Sign-in is off: the Locker cannot be on without it. */
  blocked?: boolean;
  /** The member cannot edit Core. */
  locked?: boolean;
}): React.ReactElement {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: qk.portal(slug),
    queryFn: () => api.portalSettings(slug).then((r) => r.settings),
  });
  const [pending, setPending] = React.useState<boolean | null>(null);
  const [confirming, setConfirming] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const [failedRequested, setFailedRequested] = React.useState<boolean | null>(
    null,
  );
  const on = pending ?? query.data?.portalEnabled ?? false;
  const save = async (next: boolean): Promise<void> => {
    setError(null);
    setFailedRequested(null);
    setPending(next);
    try {
      const result = await mutate("updatePortalSettings", slug, {
        portalEnabled: next,
      });
      queryClient.setQueryData(qk.portal(slug), result.settings);
      toast.success(`Polaris Locker turned ${next ? "on" : "off"}`);
    } catch (failure) {
      setError(failure);
      setFailedRequested(next);
      throw failure;
    } finally {
      setPending(null);
    }
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
  const switchId = "feature-customer-portal";
  const errorId = `${switchId}-error`;
  return (
    <>
      <FeatureSubRow
        title="Polaris Locker"
        htmlFor={switchId}
        lockedBy={blocked ? "Sign-in" : undefined}
        lockedId={`${switchId}-requirements`}
        lines={["Where customers manage their licenses and devices"]}
        footer={
          error ? (
            <div className="mt-2 flex items-center gap-3">
              <span id={errorId} role="alert" className="text-xs text-danger">
                {errorCopy(error).title}
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  if (failedRequested === null) return;
                  void save(failedRequested).catch(() => undefined);
                }}
              >
                Retry
              </Button>
            </div>
          ) : undefined
        }
        control={
          <Switch
            id={switchId}
            touch
            checked={on && !blocked}
            saving={pending !== null}
            disabled={blocked || locked}
            readOnly={query.isPending}
            aria-describedby={
              [
                blocked ? `${switchId}-requirements` : null,
                error ? errorId : null,
              ]
                .filter(Boolean)
                .join(" ") || undefined
            }
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
        title="Turn off Polaris Locker?"
        consequences={[
          "Customers can no longer open it to manage their licenses and devices.",
          "Their licenses keep working.",
        ]}
        confirmLabel="Turn off Polaris Locker"
        describeError={errorCopy}
        onConfirm={() => save(false)}
      />
    </>
  );
}
