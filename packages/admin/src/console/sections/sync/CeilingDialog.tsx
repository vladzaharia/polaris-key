/**
 * Change the product's storage ceiling: the product setting `cloudSync.ceiling.bytes`, written
 * through the generic settings write (config.cloud-sync, "Product limits"). Raising it costs the
 * platform more and confirms at the registry's `up` level (L2, a danger confirm with the passkey
 * step-up state); lowering it confirms at `down` (L1, a caution) and deletes nothing. The write
 * carries the version the row was read at: a concurrent change is refused (409), the setting
 * reloads and the typed number stays for the next try.
 */

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, type ProductSetting } from "../../../api.js";
import { errorCopy } from "../../../lib/errorCopy.js";
import { ConfirmDialog } from "../../../ui/ConfirmDialog.js";
import { Input } from "../../../ui/Input.js";
import { toast } from "../../../ui/toast.js";
import { LEVEL_RANK, intentOf } from "../../../ui/settings/model.js";
import { useMe } from "../../data/hooks.js";
import { mutate } from "../../data/mutations.js";
import { qk } from "../../data/queries.js";
import { formatBinaryBytes } from "./pages/SyncData.js";

const GiB = 1024 ** 3;

/** Bytes as the number the field shows: GiB, up to two decimals, no trailing zeros. */
const gibText = (bytes: number): string =>
  String(Number((bytes / GiB).toFixed(2)));

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
  const fieldId = React.useId();
  const me = useMe();
  const client = useQueryClient();
  const current = Number(setting.value);
  const spec = setting.spec.kind === "integer" ? setting.spec : null;
  React.useEffect(() => {
    if (open) setGib(gibText(current));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const n = Number(gib);
  const bytes = Math.round(n * GiB);
  const valid =
    gib.trim() !== "" &&
    Number.isFinite(n) &&
    n >= 0 &&
    (spec === null || (bytes >= spec.min && bytes <= spec.max));
  const changed = valid && bytes !== current;
  const raising = bytes > current;
  const problem =
    gib.trim() === "" || valid
      ? null
      : !Number.isFinite(n)
        ? "Use a number of GiB."
        : "Use a number of GiB from 0 up.";

  const levels = "up" in setting.confirm ? setting.confirm : null;
  const level = levels ? levels[raising ? "up" : "down"] : "L1";
  const below = usedBytes !== null && changed && bytes < usedBytes;

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      intent={intentOf(level)}
      title={
        raising ? "Raise the storage ceiling?" : "Lower the storage ceiling?"
      }
      lead={
        <div className="space-y-1.5">
          <label htmlFor={fieldId} className="block text-sm text-fg">
            Total storage for this product (GiB)
          </label>
          <Input
            id={fieldId}
            inputMode="decimal"
            value={gib}
            aria-invalid={problem ? true : undefined}
            aria-describedby={`${fieldId}-help`}
            onChange={(e) => setGib(e.target.value)}
          />
          <p
            id={`${fieldId}-help`}
            className={
              problem ? "text-xs text-danger" : "text-xs text-fg-muted"
            }
          >
            {problem ??
              `Now ${formatBinaryBytes(current)}${
                usedBytes === null
                  ? ""
                  : `, ${formatBinaryBytes(usedBytes)} used`
              }`}
          </p>
        </div>
      }
      consequences={
        !changed
          ? ["Everyone on this product shares the ceiling."]
          : raising
            ? [
                `Everyone on this product can store up to ${formatBinaryBytes(bytes)} in total.`,
                "Storage costs more as it fills.",
              ]
            : [
                "Nothing is deleted.",
                below
                  ? `The product holds ${formatBinaryBytes(usedBytes)}. New saves wait until it is under ${formatBinaryBytes(bytes)}.`
                  : "New saves wait when the ceiling is reached.",
              ]
      }
      confirmLabel={raising ? "Raise the ceiling" : "Lower the ceiling"}
      confirmDisabled={!changed}
      signedInAt={me.data?.authAt}
      stepUpKey={`${slug}:${setting.key}`}
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
        try {
          await mutate("updateProductSetting", slug, setting.key, {
            value: bytes,
            expectedVersion: setting.version,
            reason: `Ceiling set to ${formatBinaryBytes(bytes)}`,
            // The typed confirm of an L2 change (the registry's `up`); ignored when not asked.
            ...(LEVEL_RANK[level] >= 2 ? { confirm: setting.key } : {}),
          });
        } catch (e) {
          // A conflict: read the setting again so the next confirm names the version in force.
          if (e instanceof ApiError && e.status === 409)
            await client.invalidateQueries({
              queryKey: qk.productSettingsAll(slug),
            });
          throw e;
        }
        toast.success(`Storage ceiling set to ${formatBinaryBytes(bytes)}`);
      }}
    />
  );
}
