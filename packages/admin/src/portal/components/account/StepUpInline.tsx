import * as React from "react";
import { Button } from "../../../ui/Button.js";
import { Spinner } from "../../../ui/Spinner.js";
import { t } from "../../../lib/copy.js";
import { useMethods, useSession } from "../../data.js";
import { StepUp } from "./StepUp.js";

/**
 * "Confirm it's you first" for a control that sits outside Sign-in methods (Your data: the
 * download, the schedule and cancel of a deletion, Remove my data). It reads the account and its
 * methods itself, shows `StepUp` where the refusal would have been, and hands back to the caller on
 * a confirmed sign-in so it can run the request again. Cancel puts the control back as it was.
 */
export function StepUpInline({
  verb,
  onConfirmed,
  onCancel,
}: {
  /** What the confirmation unlocks: "download your data". */
  verb: string;
  onConfirmed: () => void;
  onCancel?: () => void;
}): React.ReactElement {
  const me = useSession();
  const methods = useMethods();
  const view = methods.data;
  const account = me.data?.account;
  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface-sunken p-4">
      {view && account ? (
        <StepUp
          verb={verb}
          view={view}
          accountId={account.id}
          returnTo={window.location.href}
          autoFocus
          onConfirmed={onConfirmed}
        />
      ) : methods.isPending || me.isPending ? (
        <Spinner className="size-4" label={t("common.loading")} />
      ) : (
        <p className="text-sm text-fg">{t("locker.stepUp.signOutRetry")}</p>
      )}
      {onCancel ? (
        <Button
          variant="outline"
          size="sm"
          className="max-sm:min-h-11"
          onClick={onCancel}
        >
          {t("common.cancel")}
        </Button>
      ) : null}
    </div>
  );
}
