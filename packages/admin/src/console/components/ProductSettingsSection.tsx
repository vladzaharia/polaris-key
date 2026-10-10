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
 * Each row is the shared `SettingRow` engine (ST-07, `ui/settings/`): value, owner, draft with
 * "Not saved · was", the confirmation, the version guard with Reload, Revert.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError, type ProductSetting } from "../../api.js";
import { ErrorState } from "../../ui/ErrorState.js";
import { Skeleton } from "../../ui/Skeleton.js";
import { SourceBadge, type Source } from "../../ui/SourceBadge.js";
import { SettingRow } from "../../ui/settings/SettingRow.js";
import {
  formatSettingValue,
  type ValueLabels,
} from "../../ui/settings/model.js";
import { toast } from "../../ui/toast.js";
import { useProduct } from "../data/hooks.js";
import { mutate } from "../data/mutations.js";
import { qk } from "../data/queries.js";
import { SettingsSection } from "../templates/Settings.js";

/** Per-setting copy a page supplies: value labels, and what a change to a value means. */
export interface SettingCopy {
  /** Display labels for enum values (the raw value is shown when absent). */
  values?: ValueLabels;
  /** Extra lines for the confirmation when the setting changes to `to`. */
  consequences?: (to: unknown) => string[];
}

const BADGE: Record<ProductSetting["source"], Source> = {
  manifest: "manifest",
  console: "admin",
  default: "default",
};

/** A write refused because the setting changed since the row was read. */
const isConflict = (e: unknown): boolean =>
  e instanceof ApiError && e.status === 409;

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
                className="text-sm font-medium text-fg-strong"
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
  const fmt = (v: unknown) => formatSettingValue(s.spec, v, copy?.values);
  const pendingRow = pendingNote !== undefined;
  const target =
    s.manifestValue !== undefined
      ? `the manifest's value, ${fmt(s.manifestValue)}`
      : `the default, ${fmt(s.defaultValue)}`;
  const claim =
    linked && s.manifestPath
      ? [
          `This claims it from ${manifestFile(s.manifestPath)}: later resyncs leave it alone until you revert it.`,
        ]
      : [];
  return (
    <SettingRow
      id={`setting-${s.key}`}
      settingKey={s.key}
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
      spec={s.spec}
      confirm={s.confirm}
      labels={copy?.values}
      value={s.value}
      version={s.version}
      critical={s.critical}
      commit="explicit"
      display={pendingRow ? "text" : "control"}
      source={
        <SourceBadge
          source={BADGE[s.source]}
          path={manifestFile(s.manifestPath)}
        />
      }
      isConflict={isConflict}
      reload={async () => onConflict()}
      consequences={(to) => [...(copy?.consequences?.(to) ?? []), ...claim]}
      save={(value, ctx) =>
        mutate("updateProductSetting", slug, s.key, {
          value,
          expectedVersion: ctx.expectedVersion,
          ...(ctx.reason ? { reason: ctx.reason } : {}),
        })
      }
      onSaved={(res) => {
        const r = res as { claimed?: boolean };
        toast.success(`${s.label} saved`, {
          description: r.claimed
            ? "Set in the console: resyncs leave it alone until you revert it."
            : undefined,
        });
      }}
      revertPlan={() =>
        s.source !== "console"
          ? null
          : {
              level: "L1",
              title: linked
                ? `Return ${s.label.toLowerCase()} to the manifest?`
                : `Reset ${s.label.toLowerCase()} to its default?`,
              consequences: [
                `${target.charAt(0).toUpperCase()}${target.slice(1)}, replaces ${fmt(s.value)} now.`,
                ...(linked
                  ? ["Later resyncs keep it in line with the manifest."]
                  : []),
              ],
              confirmLabel: linked ? "Revert to manifest" : "Reset to default",
              run: ({ expectedVersion }) =>
                mutate("revertProductSetting", slug, s.key, {
                  expectedVersion,
                }),
              onDone: (res) => {
                const r = res as { applied?: boolean };
                toast.success(
                  r.applied
                    ? `${s.label} restored`
                    : `${s.label} returns to the manifest at the next resync`,
                );
              },
            }
      }
    />
  );
}
