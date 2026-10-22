/**
 * Change the product's storage ceiling: the product setting `cloudSync.ceiling.bytes`, written
 * through the generic settings write (config.cloud-sync, "Product limits"). The title is the
 * same whatever is typed; the direction shows on the primary button ("Raise to …" in the danger
 * colour, "Lower to …") and in the confirm level the registry declares (`up` L2 sends the key,
 * `down` L1 needs only the click). The setting is critical, so the operator gives a reason; it is
 * never filled in for them. Lowering deletes nothing.
 *
 * A write carries the version the row was read at: a concurrent change is refused (409), the
 * setting reloads and what was typed stays for the next try. A ceiling the operator set can go
 * back to the platform default (the revert write).
 */

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, type ProductSetting } from "../../../api.js";
import { errorCopy } from "../../../lib/errorCopy.js";
import { formatCount } from "../../../lib/format.js";
import { Button } from "../../../ui/Button.js";
import { ConfirmDialog } from "../../../ui/ConfirmDialog.js";
import { Input } from "../../../ui/Input.js";
import { Textarea } from "../../../ui/Textarea.js";
import { toast } from "../../../ui/toast.js";
import { LEVEL_RANK } from "../../../ui/settings/model.js";
import { mutate } from "../../data/mutations.js";
import { qk } from "../../data/queries.js";
import { formatBinaryBytes } from "./pages/SyncData.js";

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

/** Bytes as words that match what was typed: whole GiB as GiB, else whole MiB. */
export function formatCeiling(bytes: number): string {
  if (bytes === 0) return "0 GiB";
  if (bytes % GiB === 0) return `${formatCount(bytes / GiB)} GiB`;
  return `${formatCount(Math.round(bytes / MiB))} MiB`;
}

/** The field's text for a value: GiB, up to three decimals, no trailing zeros. */
const gibText = (bytes: number): string =>
  String(Number((bytes / GiB).toFixed(3)));

export function CeilingDialog({
  open,
  onOpenChange,
  slug,
  setting,
  usedBytes,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  slug: string;
  setting: ProductSetting;
  /** What the product holds now, when the usage read has it. */
  usedBytes: number | null;
}): React.ReactElement {
  const [gib, setGib] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [useDefault, setUseDefault] = React.useState(false);
  const fieldId = React.useId();
  const reasonId = React.useId();
  const fieldRef = React.useRef<HTMLInputElement>(null);
  const client = useQueryClient();
  const current = Number(setting.value);
  const platformDefault = Number(setting.defaultValue);
  const spec = setting.spec.kind === "integer" ? setting.spec : null;
  const max = spec?.max ?? Number.MAX_SAFE_INTEGER;
  React.useEffect(() => {
    if (open) {
      setGib(gibText(current));
      setReason("");
      setUseDefault(false);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const n = Number(gib);
  // Whole MiB: the consequence shown is the number stored.
  const bytes = Math.round((n * GiB) / MiB) * MiB;
  const typedOk = gib.trim() !== "" && Number.isFinite(n) && n >= 0;
  const inRange = typedOk && bytes >= (spec?.min ?? 0) && bytes <= max;
  const valid = inRange && reason.trim() !== "";
  const changed = inRange && bytes !== current;
  const raising = bytes > current;
  const problem =
    gib.trim() === "" || inRange
      ? null
      : !typedOk
        ? "Use a number of GiB, 0 or more."
        : `Use 0 to ${formatCount(Math.floor(max / GiB))} GiB (1 PiB).`;

  const levels = "up" in setting.confirm ? setting.confirm : null;
  const level = levels ? levels[raising ? "up" : "down"] : "L1";
  const below = usedBytes !== null && changed && bytes < usedBytes;

  const consequences = !changed
    ? ["Everyone on this product shares the ceiling."]
    : raising
      ? [
          `Everyone on this product can store up to ${formatCeiling(bytes)} in total.`,
        ]
      : [
          "Nothing is deleted.",
          bytes === 0
            ? "Every save that adds data is refused until you raise it."
            : below
              ? `The product holds ${formatBinaryBytes(usedBytes)}. Saves that add data are refused until it holds less than ${formatCeiling(bytes)}. Reading and deleting keep working.`
              : `Saves that add data are refused once the product holds ${formatCeiling(bytes)}. Reading and deleting keep working.`,
        ];

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      intent="neutral"
      title="Change the storage ceiling"
      lead={
        <div className="space-y-1.5">
          <label htmlFor={fieldId} className="block text-sm text-fg">
            Total storage for this product (GiB)
          </label>
          <Input
            id={fieldId}
            ref={fieldRef}
            inputMode="decimal"
            value={gib}
            aria-invalid={problem ? true : undefined}
            aria-describedby={`${fieldId}-help`}
            onChange={(e) => {
              setGib(e.target.value);
              setUseDefault(false);
            }}
          />
          <p
            id={`${fieldId}-help`}
            className={
              problem ? "text-xs text-danger" : "text-xs text-fg-muted"
            }
          >
            {problem ??
              `Now ${formatCeiling(current)}${
                usedBytes === null
                  ? ""
                  : `, ${formatBinaryBytes(usedBytes)} used`
              }`}
          </p>
          {setting.source !== "default" ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setGib(gibText(platformDefault));
                setUseDefault(true);
              }}
            >
              Use the platform default ({formatCeiling(platformDefault)})
            </Button>
          ) : null}
        </div>
      }
      consequences={consequences}
      confirmLabel={
        useDefault
          ? "Use the platform default"
          : !changed
            ? "Change"
            : `${raising ? "Raise" : "Lower"} to ${formatCeiling(bytes)}`
      }
      confirmVariant={changed && raising ? "danger" : "primary"}
      confirmDisabled={useDefault ? reason.trim() === "" : !changed || !valid}
      initialFocusRef={fieldRef}
      submitOnEnter
      describeError={(e) =>
        e instanceof ApiError && e.status === 409
          ? {
              title: "The ceiling changed since you opened this",
              description:
                "Someone else saved it. Check the number and confirm again.",
            }
          : errorCopy(e, { thing: "Setting" })
      }
      onConfirm={async () => {
        const body = {
          expectedVersion: setting.version,
          reason: reason.trim(),
          // An L2 change (the registry's `up`) names the key; ignored when not asked.
          ...(LEVEL_RANK[level] >= 2 ? { confirm: setting.key } : {}),
        };
        try {
          if (useDefault)
            await mutate("revertProductSetting", slug, setting.key, body);
          else
            await mutate("updateProductSetting", slug, setting.key, {
              value: bytes,
              ...body,
            });
        } catch (e) {
          // A conflict: read the setting again so the next confirm names the version in force.
          if (e instanceof ApiError && e.status === 409)
            await client.invalidateQueries({
              queryKey: qk.productSettingsAll(slug),
            });
          throw e;
        }
        toast.success(
          useDefault
            ? "Storage ceiling is the platform default"
            : `Storage ceiling set to ${formatCeiling(bytes)}`,
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
