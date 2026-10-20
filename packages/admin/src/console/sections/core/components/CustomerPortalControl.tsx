import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../../api.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { Button } from "../../../../ui/Button.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { SettingsRow } from "../../../templates/Settings.js";
import { Switch } from "../../../../ui/Switch.js";
import { toast } from "../../../../ui/toast.js";
import { mutate } from "../../../data/mutations.js";
import { qk } from "../../../data/queries.js";

export function CustomerPortalControl({
  slug,
}: {
  slug: string;
}): React.ReactElement {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: qk.portal(slug),
    queryFn: () => api.portalSettings(slug).then((r) => r.settings),
  });
  const [pending, setPending] = React.useState<boolean | null>(null);
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
      <div className="border-t border-border px-5 py-3">
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
    <SettingsRow
      label="Show on Polaris Locker"
      htmlFor={switchId}
      help="Customers manage their licenses and devices there."
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
    >
      <Switch
        id={switchId}
        checked={on}
        readOnly={pending !== null || query.isPending}
        aria-describedby={error ? errorId : undefined}
        onCheckedChange={(next) => void save(next).catch(() => undefined)}
      />
    </SettingsRow>
  );
}
