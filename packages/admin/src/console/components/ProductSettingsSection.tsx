/**
 * One settings card over the row-backed product settings of a settings-hub area (LX-06;
 * `GET …/settings/effective?area=`, S-18 §4.5 model C). License → Settings renders
 * `license.licensing`; Identity → Sign-in renders the tier-sync row of `identity.signIn`.
 *
 * Each row shows the value in force and who owns it (`SourceBadge`: from the manifest, set in the
 * console, or the default). Editing a row and pressing Save asks for the confirmation the
 * registry declares for that direction (`confirm`: L0 saves at once, L1 is a caution, L2 a danger
 * confirm), and a reason when the setting is critical. On a repo-linked product a save claims
 * the setting, so later resyncs leave it alone; Revert hands it back to the manifest.
 *
 * Every save carries the version the row was read at (`expectedVersion`), so a concurrent change
 * is refused rather than overwritten; the card then reloads.
 *
 * A page can mark keys `pending` (P0-47): settings stored and resynced whose behaviour has not
 * shipped. They follow the live rows under a "Not in effect yet" subheading, each with its value
 * read-only and muted and the page's note on what devices do today; a console claim can still be
 * reverted.
 *
 * ST-07's `SettingsRow` v2 (history drawer, pre-save diff) replaces the per-row chrome here.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  api,
  type ProductSetting,
  type SettingConfirmLevel,
  type SettingConfirmSpec,
  type SettingValueSpec,
} from "../../api.js";
import { confirmFor } from "../../lib/actions.js";
import { errorCopy } from "../../lib/errorCopy.js";
import { Button } from "../../ui/Button.js";
import { ConfirmDialog } from "../../ui/ConfirmDialog.js";
import { ErrorState } from "../../ui/ErrorState.js";
import { NumberInput } from "../../ui/NumberInput.js";
import { Select } from "../../ui/Select.js";
import { Skeleton } from "../../ui/Skeleton.js";
import { SourceBadge, type Source } from "../../ui/SourceBadge.js";
import { Switch } from "../../ui/Switch.js";
import { Textarea } from "../../ui/Textarea.js";
import { toast } from "../../ui/toast.js";
import { useProduct } from "../data/hooks.js";
import { mutate } from "../data/mutations.js";
import { qk } from "../data/queries.js";
import { SettingsRow, SettingsSection } from "../templates/Settings.js";

/** Per-setting copy a page supplies: value labels, and what a change to a value means. */
export interface SettingCopy {
  /** Display labels for enum values (the raw value is shown when absent). */
  values?: Record<string, string>;
  /** Extra lines for the confirmation when the setting changes to `to`. */
  consequences?: (to: unknown) => string[];
}

/** The confirm level a change from `from` to `to` needs (the registry's `confirm`). */
export function confirmLevel(
  spec: SettingValueSpec,
  confirm: SettingConfirmSpec,
  from: unknown,
  to: unknown,
): SettingConfirmLevel {
  if ("change" in confirm) return confirm.change;
  if ("on" in confirm)
    return to === true || to === "on" ? confirm.on : confirm.off;
  const rank = (v: unknown): number =>
    spec.kind === "enum" ? spec.values.indexOf(String(v)) : Number(v);
  return rank(to) > rank(from) ? confirm.up : confirm.down;
}

/** A value as the console shows it. */
export function formatSettingValue(
  spec: SettingValueSpec,
  value: unknown,
  copy?: SettingCopy,
): string {
  if (spec.kind === "boolean") return value === true ? "On" : "Off";
  if (spec.kind === "switch") return value === "on" ? "On" : "Off";
  if (spec.kind === "integer")
    return `${String(value)} ${spec.unit === "count" ? "" : spec.unit}`.trim();
  if (spec.kind === "enum")
    return copy?.values?.[String(value)] ?? String(value);
  return JSON.stringify(value);
}

const BADGE: Record<ProductSetting["source"], Source> = {
  manifest: "manifest",
  console: "admin",
  default: "default",
};

const INTENT: Record<SettingConfirmLevel, "neutral" | "caution" | "danger"> = {
  L0: "neutral",
  L1: "caution",
  L2: "danger",
  L3: "danger",
};

/** `product:licensing.anchorPolicy` → `.pkey/product`'s `licensing.anchorPolicy`. */
function manifestFile(path: string | null): string {
  if (!path) return ".pkey/product";
  const [doc, dotted] = path.split(":");
  return `.pkey/${doc} ${dotted}`;
}

export function ProductSettingsSection({
  slug,
  area,
  id,
  title,
  description,
  keys,
  copy = {},
  pending = {},
  pendingDescription,
}: {
  slug: string;
  area: string;
  id: string;
  title: string;
  description?: React.ReactNode;
  /** Only these keys of the area (all of them when absent), in this order. */
  keys?: readonly string[];
  copy?: Record<string, SettingCopy>;
  /** Keys whose behaviour has not shipped, each with what devices do today: read-only rows. */
  pending?: Record<string, string>;
  /** Under the "Not in effect yet" subheading. */
  pendingDescription?: React.ReactNode;
}): React.ReactElement | null {
  const q = useQuery({
    queryKey: qk.productSettings(slug, area),
    queryFn: () => api.productSettings(slug, area),
  });
  const product = useProduct(slug).data;
  const linked = product?.releaseSource === "github";

  let body: React.ReactNode;
  if (q.isPending)
    body = (
      <div className="space-y-3 p-5" aria-busy="true">
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-6 w-full" />
      </div>
    );
  else if (!q.data)
    body = (
      <div className="p-5">
        <ErrorState error={q.error} onRetry={() => void q.refetch()} compact />
      </div>
    );
  else {
    const all = q.data.settings.filter(
      (s) => s.visibleWhen?.offBehaviour !== "hide" || s.serviceEnabled,
    );
    const rows = keys
      ? keys
          .map((k) => all.find((s) => s.key === k))
          .filter((s): s is ProductSetting => s !== undefined)
      : all;
    if (rows.length === 0) return null;
    const row = (s: ProductSetting) => (
      <ProductSettingRow
        key={s.key}
        slug={slug}
        setting={s}
        linked={linked}
        copy={copy[s.key]}
        pendingNote={pending[s.key]}
        onConflict={() => void q.refetch()}
      />
    );
    // The settings in effect first; the pending ones after them, grouped under one subheading.
    const live = rows.filter((s) => pending[s.key] === undefined);
    const later = rows.filter((s) => pending[s.key] !== undefined);
    body = (
      <>
        {live.map(row)}
        {later.length > 0 ? (
          <div role="group" aria-labelledby={`${id}-pending`}>
            <div className="space-y-0.5 px-5 pb-1 pt-4">
              <h3
                id={`${id}-pending`}
                className="text-sm font-bold text-fg-strong"
              >
                Not in effect yet
              </h3>
              {pendingDescription ? (
                <p className="text-sm text-fg-muted">{pendingDescription}</p>
              ) : null}
            </div>
            <div className="divide-y divide-border">{later.map(row)}</div>
          </div>
        ) : null}
      </>
    );
  }
  return (
    <SettingsSection id={id} title={title} description={description}>
      {body}
    </SettingsSection>
  );
}

function ProductSettingRow({
  slug,
  setting: s,
  linked,
  copy,
  pendingNote,
  onConflict,
}: {
  slug: string;
  setting: ProductSetting;
  linked: boolean;
  copy?: SettingCopy;
  /** Set when the setting's behaviour has not shipped: the row is read-only. */
  pendingNote?: string;
  onConflict: () => void;
}): React.ReactElement {
  const [draft, setDraft] = React.useState<unknown>(s.value);
  const [confirming, setConfirming] = React.useState(false);
  const [reverting, setReverting] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const controlId = React.useId();
  // A new value from the server (a save, a revert, a resync) replaces the draft.
  React.useEffect(() => setDraft(s.value), [s.value, s.version]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(s.value);
  const level = confirmLevel(s.spec, s.confirm, s.value, draft);
  const fmt = (v: unknown) => formatSettingValue(s.spec, v, copy);

  const save = async () => {
    try {
      const res = await mutate("updateProductSetting", slug, s.key, {
        value: draft,
        expectedVersion: s.version,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      setReason("");
      toast.success(`${s.label} saved`, {
        description: res.claimed
          ? "Set in the console: resyncs leave it alone until you revert it."
          : undefined,
      });
    } catch (e) {
      onConflict();
      throw e;
    }
  };

  const onSave = () => {
    if (level === "L0" && !s.critical)
      void save().catch((e: unknown) => toast.error(errorCopy(e).title));
    else setConfirming(true);
  };

  const pendingRow = pendingNote !== undefined;
  let control: React.ReactNode;
  if (pendingRow)
    control = <span className="text-sm text-fg-muted">{fmt(s.value)}</span>;
  else if (s.spec.kind === "enum")
    control = (
      <Select
        id={controlId}
        value={String(draft)}
        onChange={(v) => v !== null && setDraft(v)}
        options={s.spec.values.map((v) => ({
          value: v,
          label: copy?.values?.[v] ?? v,
        }))}
        className="min-w-56"
      />
    );
  else if (s.spec.kind === "boolean")
    control = (
      <Switch
        id={controlId}
        checked={draft === true}
        onCheckedChange={setDraft}
        aria-label={s.label}
      />
    );
  else if (s.spec.kind === "integer")
    control = (
      <NumberInput
        id={controlId}
        value={typeof draft === "number" ? draft : null}
        onChange={(v) => setDraft(v ?? s.value)}
        integer
        min={s.spec.min}
        max={s.spec.max}
        unit={s.spec.unit === "count" ? undefined : s.spec.unit}
        className="w-36"
      />
    );
  else control = <code className="font-mono text-xs">{fmt(s.value)}</code>;

  const revertTarget =
    s.manifestValue !== undefined
      ? `the manifest's value, ${fmt(s.manifestValue)}`
      : `the default, ${fmt(s.defaultValue)}`;

  return (
    <>
      <SettingsRow
        label={s.label}
        help={
          pendingRow ? (
            <>
              {s.description} <span className="text-fg">{pendingNote}</span>
            </>
          ) : (
            s.description
          )
        }
        htmlFor={pendingRow ? undefined : controlId}
        source={
          <SourceBadge
            source={BADGE[s.source]}
            path={manifestFile(s.manifestPath)}
            onRevert={
              s.source === "console" ? () => setReverting(true) : undefined
            }
          />
        }
        footer={
          dirty ? (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setDraft(s.value)}
              >
                Discard
              </Button>
              <Button size="sm" onClick={onSave}>
                Save…
              </Button>
            </div>
          ) : undefined
        }
      >
        {control}
      </SettingsRow>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        intent={INTENT[level]}
        title={`Change ${s.label.toLowerCase()} to ${fmt(draft)}?`}
        consequences={[
          ...(copy?.consequences?.(draft) ?? []),
          ...(linked && s.manifestPath
            ? [
                `This claims it from ${manifestFile(s.manifestPath)}: later resyncs leave it alone until you revert it.`,
              ]
            : []),
        ]}
        confirmLabel={`Change ${s.label.toLowerCase()}`}
        confirmDisabled={s.critical && reason.trim() === ""}
        describeError={(e) => errorCopy(e)}
        onConfirm={save}
      >
        {s.critical ? (
          <label className="block space-y-1 text-sm">
            <span className="font-bold text-fg-strong">Reason</span>
            <Textarea
              value={reason}
              onValueChange={setReason}
              maxLength={500}
              rows={2}
              placeholder="Why this changes (kept in the activity log)"
            />
          </label>
        ) : null}
      </ConfirmDialog>
      <ConfirmDialog
        open={reverting}
        onOpenChange={setReverting}
        intent={confirmFor("manifest.revert").intent as "caution"}
        title={
          linked
            ? `Return ${s.label.toLowerCase()} to the manifest?`
            : `Reset ${s.label.toLowerCase()} to its default?`
        }
        consequences={[
          `${revertTarget.charAt(0).toUpperCase()}${revertTarget.slice(1)}, replaces ${fmt(s.value)} now.`,
          ...(linked
            ? ["Later resyncs keep it in line with the manifest."]
            : []),
        ]}
        confirmLabel={linked ? "Revert to manifest" : "Reset to default"}
        describeError={(e) => errorCopy(e)}
        onConfirm={async () => {
          try {
            const res = await mutate("revertProductSetting", slug, s.key, {
              expectedVersion: s.version,
            });
            toast.success(
              res.applied
                ? `${s.label} restored`
                : `${s.label} returns to the manifest at the next resync`,
            );
          } catch (e) {
            onConflict();
            throw e;
          }
        }}
      />
    </>
  );
}
