/**
 * Package feeds policy in Storefront and hosting (ST-09; moved from the Package feeds page).
 * One compact row per ecosystem: its name, the kill switch and the size ceiling. Both controls
 * run the settings engine's write flow (`useSettingWrite`: confirm level, `expectedVersion`, 409
 * with Reload, input kept on failure). Both write the one policy record, so each carries its
 * version and the page refetches after a save. Viewing needs Platform access, changing Platform
 * edit; without it the row shows its values with a lock and the page says why once.
 */

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import type { FeedEcosystem, FeedPolicy } from "../../../../api.js";
import { Button } from "../../../../ui/Button.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { NumberInput } from "../../../../ui/NumberInput.js";
import { PageSkeleton } from "../../../../ui/Skeleton.js";
import { Switch } from "../../../../ui/Switch.js";
import { ConflictNote } from "../../../../ui/settings/SettingExtras.js";
import {
  formatSettingValue,
  fromField,
  toField,
  type SettingSpec,
} from "../../../../ui/settings/model.js";
import { useSettingWrite } from "../../../../ui/settings/useSettingWrite.js";
import { toast } from "../../../../ui/toast.js";
import { useWriteGate } from "../../../access/useCan.js";
import { mutate } from "../../../data/mutations.js";
import { qk } from "../../../data/queries.js";
import { useFeedsOverview } from "../../feeds/data.js";
import { isConflict } from "./platformSettingRow.js";

const PLATFORM = { kind: "platform" } as const;
const MIB = 1_048_576;
const MAX_MIB = 5120;

const CEILING_SPEC: SettingSpec = {
  kind: "integer",
  unit: "bytes",
  min: MIB,
  max: MAX_MIB * MIB,
};

/** What is wrong with a ceiling draft, in the field's own unit; `null` when it can be saved. */
export function ceilingError(bytes: unknown): string | null {
  if (typeof bytes !== "number" || !Number.isFinite(bytes))
    return "Enter a size.";
  if (bytes < MIB) return "Enter at least 1 MiB.";
  if (bytes > MAX_MIB * MIB) return "Enter 5,120 MiB or less.";
  return null;
}

export function FeedPolicySection(): React.ReactElement | null {
  const query = useFeedsOverview(PLATFORM);
  const rows = (query.data?.policies ?? []).filter((p) => p.policy !== null);
  const affected = (query.data?.owners ?? []).filter(
    (o) => o.packageFeeds,
  ).length;
  const head = (body: React.ReactNode) => (
    <div
      id="platform-feeds-policy"
      tabIndex={-1}
      role="group"
      aria-labelledby="platform-feeds-policy-title"
      className="border-t border-border outline-none"
    >
      <div className="px-5 pt-4">
        <h3
          id="platform-feeds-policy-title"
          className="text-sm font-semibold text-fg-strong"
        >
          Package feeds
        </h3>
        <p className="text-sm text-fg-muted">
          Each switch and ceiling applies to every product&apos;s feed of that
          ecosystem. Ceilings go up to 5,120 MiB.
        </p>
      </div>
      {body}
    </div>
  );
  if (query.isPending)
    return head(<PageSkeleton template="form" label="package feeds policy" />);
  if (query.isError)
    return head(
      <div className="px-5 py-3">
        <ErrorState
          compact
          error={query.error}
          onRetry={() => void query.refetch()}
          context={{ area: "distribution", thing: "Package feeds policy" }}
        />
      </div>,
    );
  if (rows.length === 0) return null;
  return head(
    <ul className="mt-2 divide-y divide-border">
      {rows.map((p) => (
        <li key={p.ecosystem}>
          <PolicyRow
            eco={p.ecosystem}
            label={p.label}
            policy={p.policy!}
            affected={affected}
          />
        </li>
      ))}
    </ul>,
  );
}

function PolicyRow({
  eco,
  label,
  policy,
  affected,
}: {
  eco: FeedEcosystem;
  label: string;
  policy: FeedPolicy;
  affected: number;
}): React.ReactElement {
  const queryClient = useQueryClient();
  const write = useWriteGate("platform");
  const reload = () =>
    queryClient.refetchQueries({ queryKey: qk.pkgFeeds(PLATFORM) });
  const readOnly = !write.allowed;
  const reason = write.disabledReason ?? "You can't edit this.";
  const id = `platform-feeds-${eco}`;
  const products = (n: number) => `${n} ${n === 1 ? "product" : "products"}`;

  const enabled = useSettingWrite({
    label: `Serve ${label}`,
    settingKey: `feeds.policy.${eco}.enabled`,
    spec: { kind: "switch" },
    confirm: { on: "L0", off: "L2" },
    value: policy.enabled ? "on" : "off",
    version: policy.version,
    commit: "immediate",
    isConflict,
    reload,
    confirmCopy: () => ({
      title: `Stop serving ${label} for every product?`,
      confirmLabel: `Stop serving ${label}`,
    }),
    consequences: (to) =>
      to === "off"
        ? [
            `The ${label} feeds of ${products(affected)} answer not-found within 30 seconds.`,
            "Settings, packages and versions are kept; the feeds answer again when the ecosystem is served.",
          ]
        : [`Every ${label} feed serves as its own settings say.`],
    save: (value, ctx) =>
      mutate("saveFeedPolicy", eco, {
        expectedVersion: ctx.expectedVersion,
        enabled: value === "on",
      }),
    onSaved: (_r, done) =>
      toast.success(`${label} ${done.value === "on" ? "served" : "stopped"}`),
  });
  const ceiling = useSettingWrite({
    label: `${label} size ceiling`,
    settingKey: `feeds.policy.${eco}.ceiling`,
    spec: CEILING_SPEC,
    confirm: { up: "L0", down: "L0" },
    value: policy.maxPackageBytesCeiling,
    version: policy.version,
    commit: "explicit",
    isConflict,
    reload,
    consequences: () => [
      `New ${label} publishes above the ceiling are refused.`,
    ],
    save: (value, ctx) =>
      mutate("saveFeedPolicy", eco, {
        expectedVersion: ctx.expectedVersion,
        maxPackageBytesCeiling: value as number,
      }),
    onSaved: () => toast.success(`${label} size ceiling saved`),
  });

  const draftBad = ceiling.dirty ? ceilingError(ceiling.draft) : null;
  const errId = `${id}-ceiling-error`;
  const busy = enabled.busy || ceiling.busy;
  return (
    <div className="space-y-2 px-5 py-3" data-eco={eco}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="min-w-24 flex-1 text-sm font-medium text-fg-strong">
          {label}
        </span>
        <div
          className="flex items-center gap-2"
          onKeyDown={(e) => {
            if (e.key === "Enter" && ceiling.dirty && !draftBad && !busy) {
              e.preventDefault();
              ceiling.commit();
            } else if (e.key === "Escape" && ceiling.dirty) {
              e.stopPropagation();
              ceiling.discard();
            }
          }}
        >
          {readOnly ? (
            <span
              className="inline-flex items-center gap-1.5 text-sm font-medium text-fg-strong"
              aria-describedby={`${id}-readonly`}
            >
              <Lock aria-hidden className="size-3.5 text-fg-muted" />
              {formatSettingValue(CEILING_SPEC, policy.maxPackageBytesCeiling)}
            </span>
          ) : (
            <div className="w-40">
              <NumberInput
                id={`${id}-ceiling`}
                aria-label={`${label} size ceiling (MiB)`}
                aria-invalid={draftBad ? true : undefined}
                aria-describedby={draftBad ? errId : undefined}
                value={
                  typeof ceiling.draft === "number"
                    ? toField(CEILING_SPEC, ceiling.draft)
                    : null
                }
                onChange={(v) =>
                  ceiling.setDraft(
                    v === null ? null : fromField(CEILING_SPEC, v),
                  )
                }
                unit="MiB"
                min={1}
                max={MAX_MIB}
                step="any"
                disabled={busy}
              />
            </div>
          )}
          {ceiling.dirty && !readOnly ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={ceiling.discard}
                disabled={ceiling.busy}
              >
                Discard
              </Button>
              <Button
                size="sm"
                loading={ceiling.busy}
                disabled={draftBad !== null}
                onClick={() => ceiling.commit()}
              >
                Save
              </Button>
            </>
          ) : null}
        </div>
        <span className="ml-auto inline-flex items-center gap-2">
          {readOnly ? (
            <Lock aria-hidden className="size-3.5 text-fg-muted" />
          ) : null}
          <Switch
            id={`${id}-enabled`}
            aria-label={`Serve ${label}`}
            aria-describedby={readOnly ? `${id}-readonly` : undefined}
            checked={enabled.draft === "on"}
            disabled={readOnly}
            readOnly={enabled.busy}
            aria-busy={enabled.busy || undefined}
            onCheckedChange={(next) => enabled.propose(next ? "on" : "off")}
          />
        </span>
      </div>
      {readOnly ? (
        <span id={`${id}-readonly`} className="sr-only">
          Read-only. {reason}
        </span>
      ) : null}
      {draftBad ? (
        <p id={errId} role="alert" className="text-sm text-danger">
          {draftBad}
        </p>
      ) : null}
      {ceiling.dirty && !draftBad && !readOnly ? (
        <p className="text-xs text-fg-muted">
          Not saved · was{" "}
          {formatSettingValue(CEILING_SPEC, policy.maxPackageBytesCeiling)}
        </p>
      ) : null}
      {[enabled, ceiling].map((w, i) =>
        w.error ? (
          <p key={i} role="alert" className="text-sm font-medium text-danger">
            {w.error.title}
            {w.error.description ? (
              <span className="block font-normal text-fg-muted">
                {w.error.description}
              </span>
            ) : null}
          </p>
        ) : null,
      )}
      <ConflictNote
        state={enabled.conflict ?? ceiling.conflict}
        reloading={enabled.reloading || ceiling.reloading}
        onReload={() => {
          void enabled.reload();
          void ceiling.reload();
        }}
        onDismiss={() => {
          enabled.clearConflict();
          ceiling.clearConflict();
        }}
        now={`${policy.enabled ? "served" : "stopped"}, ${formatSettingValue(CEILING_SPEC, policy.maxPackageBytesCeiling)}`}
        draft={
          ceiling.dirty && typeof ceiling.draft === "number"
            ? formatSettingValue(CEILING_SPEC, ceiling.draft)
            : undefined
        }
      />
      {enabled.dialog}
      {ceiling.dialog}
    </div>
  );
}
