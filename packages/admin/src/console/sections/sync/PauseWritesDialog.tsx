/**
 * Pause (or resume) Cloud Sync writes: the platform kill switch `cloudSync.writesPaused`
 * (config.pause-writes). It names who the change reaches, asks for a reason and, being L2, the
 * passkey: the Worker answers `step_up_required` to a stale sign-in and the ConfirmDialog turns
 * into its step-up state (D11). Resuming is L1 and needs the reason too (the setting is critical).
 */

import * as React from "react";
import { type PlatformSwitchSetting } from "../../../api.js";
import { errorCopy } from "../../../lib/errorCopy.js";
import { ConfirmDialog } from "../../../ui/ConfirmDialog.js";
import { Textarea } from "../../../ui/Textarea.js";
import { toast } from "../../../ui/toast.js";
import { LEVEL_RANK } from "../../../ui/settings/model.js";
import { useMe, useProducts } from "../../data/hooks.js";
import { mutate } from "../../data/mutations.js";

const products = (n: number): string => (n === 1 ? "product" : "products");

export function PauseWritesDialog({
  open,
  onOpenChange,
  setting,
  to,
  propagationSeconds,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  setting: PlatformSwitchSetting;
  /** `on`: pause; `off`: resume. */
  to: "on" | "off";
  propagationSeconds: number;
}): React.ReactElement {
  const [reason, setReason] = React.useState("");
  const reasonId = React.useId();
  const all = useProducts();
  const me = useMe();
  React.useEffect(() => {
    if (open) setReason("");
  }, [open]);

  const reached = (all.data ?? []).filter((p) => p.services?.sync?.enabled);
  const pausing = to === "on";
  const level = setting.confirm[to];
  const effect = `Takes effect within ${propagationSeconds} seconds.`;

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      intent={pausing ? "danger" : "caution"}
      title={
        pausing
          ? "Pause Cloud Sync writes everywhere?"
          : "Resume Cloud Sync writes?"
      }
      lead={
        reached.length === 0 ? (
          <p className="text-fg">No product has Cloud Sync on.</p>
        ) : (
          <div>
            <p className="font-medium text-fg-strong">
              {pausing
                ? `${reached.length === 1 ? "The product" : `All ${reached.length} products`} with Cloud Sync ${reached.length === 1 ? "stops" : "stop"} taking new data:`
                : `${reached.length === 1 ? "The product" : `All ${reached.length} products`} with Cloud Sync ${reached.length === 1 ? "takes" : "take"} new data again:`}
            </p>
            <ul className="mt-1 space-y-0.5 text-fg">
              {reached.map((p) => (
                <li key={p.slug} className="[overflow-wrap:anywhere]">
                  <bdi className="font-medium text-fg-strong">
                    {p.name || p.slug}
                  </bdi>
                </li>
              ))}
            </ul>
          </div>
        )
      }
      consequences={
        pausing
          ? [
              "Reading keeps working.",
              "Nothing is deleted.",
              `Devices keep their changes and send them on resume. ${effect}`,
            ]
          : [`Devices send what they kept. ${effect}`]
      }
      confirmLabel={
        pausing
          ? `Pause writes for ${reached.length} ${products(reached.length)}`
          : "Resume writes"
      }
      confirmDisabled={reason.trim() === ""}
      signedInAt={me.data?.authAt}
      stepUpKey={`${setting.key}:${to}`}
      describeError={(e) => errorCopy(e, { thing: "Setting" })}
      onConfirm={async () => {
        await mutate("patchPlatformSetting", setting.key, {
          value: to,
          expectedVersion: setting.version,
          reason: reason.trim(),
          ...(LEVEL_RANK[level] >= 2 ? { confirm: setting.key } : {}),
        });
        toast.success(
          pausing ? "Cloud Sync writes paused" : "Cloud Sync writes resumed",
        );
      }}
    >
      <div className="space-y-1.5">
        <label htmlFor={reasonId} className="block text-sm text-fg">
          Reason <span className="text-fg-muted">Required</span>
        </label>
        <Textarea
          id={reasonId}
          value={reason}
          onValueChange={setReason}
          maxLength={500}
          aria-required
        />
        <p className="text-xs text-fg-muted">Recorded in Activity.</p>
      </div>
    </ConfirmDialog>
  );
}
