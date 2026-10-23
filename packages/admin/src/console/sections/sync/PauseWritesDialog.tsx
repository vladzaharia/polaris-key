/**
 * Pause (or resume) Cloud Sync writes: the platform kill switch `cloudSync.writesPaused`
 * (config.pause-writes). It names who the change reaches, asks for a reason and, being L2, the
 * passkey: the Worker answers `step_up_required` to a stale sign-in and the ConfirmDialog turns
 * into its step-up state (D11). Resuming is L1 and needs the reason too (the setting is critical).
 */

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type PlatformSwitchSetting } from "../../../api.js";
import { qk } from "../../data/queries.js";
import { errorCopy } from "../../../lib/errorCopy.js";
import { ConfirmDialog } from "../../../ui/ConfirmDialog.js";
import { Textarea } from "../../../ui/Textarea.js";
import { toast } from "../../../ui/toast.js";
import { LEVEL_RANK } from "../../../ui/settings/model.js";
import { formatSince } from "../../../lib/format.js";
import { useMe, useProducts } from "../../data/hooks.js";
import { mutate } from "../../data/mutations.js";

/** Where the dialog's typed state waits across a step-up sign-in. */
export const stepUpKeyFor = (key: string, to: "on" | "off"): string =>
  `${key}:${to}`;

const products = (n: number): string => (n === 1 ? "product" : "products");

/** Who paused writes, when, and why: what the resume dialog and the banner say. */
export interface PauseNotice {
  since: number | null;
  by: string | null;
  reason: string | null;
}

/** "Paused since 1:14 PM by Ana Lima." and, when there is one, the reason in quotes. */
export function PauseNoticeLine({
  notice,
}: {
  notice: PauseNotice;
}): React.ReactElement {
  return (
    <>
      {notice.since
        ? `Paused since ${formatSince(notice.since * 1000)}`
        : "Paused"}
      {notice.by ? (
        <>
          {" by "}
          <bdi>{notice.by}</bdi>
        </>
      ) : null}
      {"."}
      {notice.reason ? (
        <>
          {" "}
          <bdi>
            “{notice.reason}
            {/[.!?…]$/.test(notice.reason.trim()) ? "" : "."}”
          </bdi>
        </>
      ) : null}
    </>
  );
}

export function PauseWritesDialog({
  open,
  onOpenChange,
  setting,
  to,
  propagationSeconds,
  notice,
  reachUnlisted = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  setting: PlatformSwitchSetting;
  /** `on`: pause; `off`: resume. */
  to: "on" | "off";
  propagationSeconds: number;
  /** Who paused it and why, led with when resuming. */
  notice?: PauseNotice | null;
  /**
   * The caller cannot list products (a Platform admin with no product grant sees none, though
   * the switch reaches them): say so in words instead of naming "no product".
   */
  reachUnlisted?: boolean;
}): React.ReactElement {
  const [reason, setReason] = React.useState("");
  const reasonRef = React.useRef<HTMLTextAreaElement>(null);
  const reasonId = React.useId();
  const all = useProducts();
  const me = useMe();
  const qc = useQueryClient();
  // A reason put back after the step-up sign-in must survive the fresh-open reset below (this
  // effect runs after ConfirmDialog's, which restores it).
  const restored = React.useRef(false);
  React.useEffect(() => {
    if (!open) return;
    if (restored.current) restored.current = false;
    else setReason("");
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
        <div className="space-y-3">
          {!pausing && notice ? (
            <p className="text-fg">
              <PauseNoticeLine notice={notice} />
            </p>
          ) : null}
          {reached.length === 0 && reachUnlisted ? (
            <p className="font-medium text-fg-strong">
              {pausing
                ? "Every product with Cloud Sync stops taking new data."
                : "Every product with Cloud Sync takes new data again."}
            </p>
          ) : reached.length === 0 ? (
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
          )}
        </div>
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
          ? reachUnlisted && reached.length === 0
            ? "Pause writes"
            : `Pause writes for ${reached.length} ${products(reached.length)}`
          : "Resume writes"
      }
      confirmDisabled={reason.trim() === ""}
      initialFocusRef={reasonRef}
      signedInAt={me.data?.authAt}
      stepUpKey={stepUpKeyFor(setting.key, to)}
      stepUpState={{ reason }}
      onRestore={(saved) => {
        restored.current = true;
        setReason(saved.reason ?? "");
      }}
      describeError={(e) =>
        e instanceof ApiError && e.status === 409
          ? {
              title: "Another admin changed this first.",
              description: "Close this and check the current state.",
            }
          : errorCopy(e, { thing: "Setting" })
      }
      onConfirm={async () => {
        try {
          await mutate("patchPlatformSetting", setting.key, {
            value: to,
            expectedVersion: setting.version,
            reason: reason.trim(),
            ...(LEVEL_RANK[level] >= 2 ? { confirm: setting.key } : {}),
          });
        } catch (e) {
          if (!(e instanceof ApiError) || e.status !== 409) throw e;
          // The switch moved under us: ask again. If it already is where this write was going,
          // the other admin did the work; say so and close.
          const fresh = await api.platformSettings().catch(() => null);
          void qc.invalidateQueries({ queryKey: qk.platformSettings() });
          void qc.invalidateQueries({ queryKey: qk.attention() });
          const now = fresh?.settings?.find((x) => x.key === setting.key);
          if (now && "value" in now && now.value === to) {
            toast.info(
              pausing
                ? "Writes were already paused."
                : "Writes were already resumed.",
            );
            return;
          }
          throw e;
        }
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
          ref={reasonRef}
          id={reasonId}
          value={reason}
          onValueChange={setReason}
          maxLength={500}
          aria-required
        />
        <p className="text-xs text-fg-muted">
          {pausing
            ? "Platform admins see it in the banner. Recorded in Activity."
            : "Recorded in Activity."}
        </p>
      </div>
    </ConfirmDialog>
  );
}
