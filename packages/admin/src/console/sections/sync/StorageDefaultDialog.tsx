/**
 * Change the default storage per person: the platform setting `cloudSync.quota.defaultBytes`
 * (config.storage-default). One write reaches every product with Cloud Sync on, so the dialog
 * leads with who it reaches (the ST-16 reach read, `useReachPlan`) and holds Confirm until that
 * count has resolved. It is L2: a stale sign-in turns the dialog into its step-up state (D11).
 */

import * as React from "react";
import { type PlatformIntegerSetting } from "../../../api.js";
import { errorCopy } from "../../../lib/errorCopy.js";
import { ConfirmDialog } from "../../../ui/ConfirmDialog.js";
import { Input } from "../../../ui/Input.js";
import { toast } from "../../../ui/toast.js";
import { LEVEL_RANK } from "../../../ui/settings/model.js";
import { useMe } from "../../data/hooks.js";
import { mutate } from "../../data/mutations.js";
import { useReachPlan } from "../platform/pages/platformReach.js";
import { formatBinaryBytes } from "./pages/SyncData.js";

const MiB = 1024 * 1024;

export function StorageDefaultDialog({
  open,
  onOpenChange,
  setting,
  propagationSeconds,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  setting: PlatformIntegerSetting;
  propagationSeconds: number;
}): React.ReactElement {
  const [mib, setMib] = React.useState("");
  const fieldId = React.useId();
  const me = useMe();
  React.useEffect(() => {
    if (open) setMib(String(Math.round(setting.value / MiB)));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const n = Number(mib);
  const bytes = n * MiB;
  const valid =
    mib.trim() !== "" &&
    Number.isInteger(n) &&
    bytes >= setting.min &&
    bytes <= setting.max;
  const changed = valid && bytes !== setting.value;
  const problem =
    mib.trim() === "" || valid
      ? null
      : !Number.isInteger(n)
        ? "Use a whole number of MiB."
        : `Between ${formatBinaryBytes(setting.min)} and ${formatBinaryBytes(setting.max)}.`;

  const plan = useReachPlan(
    setting,
    open && changed ? { value: bytes, revert: false } : null,
    propagationSeconds,
    "Tiers that don't set their own get it on their next sync.",
  );

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      intent="caution"
      title="Change the default storage in every product?"
      lead={
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label htmlFor={fieldId} className="block text-sm text-fg">
              Default storage per person (MiB)
            </label>
            <Input
              id={fieldId}
              inputMode="numeric"
              value={mib}
              aria-invalid={problem ? true : undefined}
              aria-describedby={`${fieldId}-help`}
              onChange={(e) => setMib(e.target.value)}
            />
            <p
              id={`${fieldId}-help`}
              className={
                problem ? "text-xs text-danger" : "text-xs text-fg-muted"
              }
            >
              {problem ?? `Now ${formatBinaryBytes(setting.value)}`}
            </p>
          </div>
          {plan?.summary}
        </div>
      }
      consequences={
        plan?.consequences ?? [
          `Tiers that don't set their own get it on their next sync. Takes effect within ${propagationSeconds} seconds.`,
          "To change one product only, give its tiers their own value.",
        ]
      }
      confirmLabel={plan?.confirmLabel ?? "Change the default"}
      confirmDisabled={!changed || plan?.hold === true}
      signedInAt={me.data?.authAt}
      stepUpKey={setting.key}
      describeError={(e) => errorCopy(e, { thing: "Setting" })}
      onConfirm={async () => {
        await mutate("patchPlatformSetting", setting.key, {
          value: bytes,
          expectedVersion: setting.version,
          reason: `Default storage set to ${formatBinaryBytes(bytes)}`,
          ...(LEVEL_RANK[
            setting.confirm[bytes > setting.value ? "raise" : "lower"]
          ] >= 2
            ? { confirm: setting.key }
            : {}),
        });
        toast.success(`Default storage set to ${formatBinaryBytes(bytes)}`);
      }}
    />
  );
}
