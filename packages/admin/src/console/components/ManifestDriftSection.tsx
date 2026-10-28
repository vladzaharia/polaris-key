/**
 * Settings → "Differs from the manifest" (ST-17, S-18 §4.5 items 4–5): every setting the console
 * has claimed on a repo-linked product, set against the last applied manifest.
 *
 * Each row names the console's value and the manifest's, and offers the two choices a claim has:
 * **Revert** hands the field back to `.pkey/` now (the same confirm the source badge opens), and
 * **Keep** leaves it as the console set it (resyncs already leave it alone, so Keep calls
 * nothing: the row only records, for this visit, that the operator looked and chose). The last
 * apply's plan warnings are listed below the rows.
 *
 * The read is `GET …/settings/drift`; a revert refreshes it (the mutation table).
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, CircleDashed, GitCompareArrows } from "lucide-react";
import {
  type ClaimKey,
  type SettingsDrift,
  type SettingsDriftItem,
} from "../../api.js";
import { errorCopy } from "../../lib/errorCopy.js";
import { formatCount, fromSeconds } from "../../lib/format.js";
import { Button } from "../../ui/Button.js";
import { Callout } from "../../ui/Callout.js";
import { ConfirmDialog } from "../../ui/ConfirmDialog.js";
import { ErrorState } from "../../ui/ErrorState.js";
import { announce } from "../../ui/LiveRegion.js";
import { Skeleton } from "../../ui/Skeleton.js";
import { StatusPill } from "../../ui/StatusPill.js";
import { Timestamp } from "../../ui/Timestamp.js";
import { toast } from "../../ui/toast.js";
import { mutate } from "../data/mutations.js";
import { reads } from "../data/reads.js";
import { intentOf } from "../sections/core/pages/confirmGate.js";
import { SettingsSection } from "../templates/Settings.js";
import { CLAIM_LABELS, RevertClaimDialog } from "./RevertClaimDialog.js";

/** A value the way an operator reads it: text as is, lists joined, anything else as JSON. */
export function driftValue(v: unknown): string {
  if (v === null || v === undefined) return "Not set";
  if (typeof v === "string") return v === "" ? "Empty" : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v))
    return v.length === 0 ? "None" : v.map(driftValue).join(", ");
  return JSON.stringify(v);
}

const list = (ids: string[]): string =>
  ids.length <= 3
    ? ids.join(", ")
    : `${ids.slice(0, 3).join(", ")} and ${ids.length - 3} more`;

/** What the manifest's catalog does against the console's, in words. */
function catalogChange(c: NonNullable<SettingsDriftItem["changes"]>): string {
  const parts = [
    c.added.length ? `adds ${list(c.added)}` : "",
    c.removed.length ? `drops ${list(c.removed)}` : "",
    c.changed.length ? `changes ${list(c.changed)}` : "",
  ].filter(Boolean);
  return parts.length ? `The manifest ${parts.join("; ")}` : "Same keys";
}

function isClaimKey(item: SettingsDriftItem): boolean {
  return item.revert === "claim";
}

/** "Console: X → Manifest: Y": what a revert changes, for the dialog; none for a catalog diff. */
function driftChange(item: SettingsDriftItem): string | undefined {
  if (item.changes || !item.manifestKnown || !item.differs) return undefined;
  return `Console: ${driftValue(item.console)} → Manifest: ${driftValue(item.manifest)}`;
}

/** Revert for a row-backed key: the same confirm as the claim's, calling the row route. */
function RevertSettingDialog({
  slug,
  item,
  onOpenChange,
}: {
  slug: string;
  item: SettingsDriftItem;
  onOpenChange: (open: boolean) => void;
}): React.ReactElement {
  return (
    <ConfirmDialog
      open
      onOpenChange={onOpenChange}
      intent={intentOf("manifest.revert")}
      title={`Return ${item.label.toLowerCase()} to the manifest?`}
      consequences={[
        ...(driftChange(item) ? [driftChange(item)!] : []),
        "The value from the last applied .pkey/product replaces the console value now.",
        "Later resyncs keep it in line with the manifest.",
      ]}
      confirmLabel="Revert to manifest"
      describeError={(e) => errorCopy(e)}
      onConfirm={async () => {
        const res = await mutate("revertProductSetting", slug, item.key, {
          expectedVersion: item.version,
        });
        toast.success(
          res.applied
            ? `${item.label} restored from the manifest`
            : `${item.label} returns to the manifest at the next resync`,
        );
      }}
    />
  );
}

function DriftRow({
  item,
  kept,
  onRevert,
  onKeep,
}: {
  item: SettingsDriftItem;
  kept: boolean;
  onRevert: () => void;
  onKeep: () => void;
}): React.ReactElement {
  const status = !item.manifestKnown ? (
    <StatusPill tone="neutral" icon={CircleDashed}>
      Manifest not read yet
    </StatusPill>
  ) : item.differs ? (
    <StatusPill tone="warning">Differs</StatusPill>
  ) : (
    <StatusPill tone="success">Matches</StatusPill>
  );
  const catalog = item.changes;
  // A claim this console doesn't know (a newer Worker added it) can't be worded or reverted here.
  const unknownClaim = isClaimKey(item) && !(item.key in CLAIM_LABELS);
  // A row that already matches has nothing to revert or keep: it can only be handed back.
  const matches = item.manifestKnown && !item.differs;
  return (
    <li
      className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start sm:justify-between"
      data-testid={`drift-${item.key}`}
    >
      <div className="min-w-0 space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h3 className="text-sm font-medium text-fg-strong">{item.label}</h3>
          {status}
          {kept ? (
            <StatusPill tone="neutral" icon={Check}>
              Kept
            </StatusPill>
          ) : null}
        </div>
        {catalog ? (
          <p className="text-sm text-fg">
            {item.differs
              ? catalogChange(catalog)
              : "Same catalog as the manifest"}
          </p>
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
            <dt className="text-fg-muted">Console</dt>
            <dd className="min-w-0 break-words text-fg">
              {driftValue(item.console)}
            </dd>
            <dt className="text-fg-muted">Manifest</dt>
            <dd className="min-w-0 break-words text-fg">
              {item.manifestKnown ? driftValue(item.manifest) : "Unknown"}
            </dd>
          </dl>
        )}
      </div>
      <div className="flex min-w-0 max-w-full flex-wrap gap-2 sm:shrink-0">
        {unknownClaim ? (
          <span className="self-center text-sm text-fg-muted">
            Revert in a newer console
          </span>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="max-w-full text-start"
            aria-label={
              matches
                ? `Hand ${item.label} back to the manifest`
                : `Revert ${item.label} to the manifest`
            }
            onClick={onRevert}
          >
            {matches ? "Hand back to manifest" : "Revert"}
          </Button>
        )}
        {matches ? null : (
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Keep ${item.label} as set in the console`}
            aria-pressed={kept}
            onClick={onKeep}
          >
            Keep
          </Button>
        )}
      </div>
    </li>
  );
}

export function ManifestDriftSection({
  slug,
}: {
  slug: string;
}): React.ReactElement {
  const q = useQuery(reads.settingsDrift(slug));
  const [kept, setKept] = React.useState<ReadonlySet<string>>(new Set());
  const [reverting, setReverting] = React.useState<SettingsDriftItem | null>(
    null,
  );
  const data: SettingsDrift | undefined = q.data;

  const keep = (item: SettingsDriftItem): void => {
    setKept((k) => new Set(k).add(item.key));
    announce(`${item.label} stays as set in the console`);
  };

  let body: React.ReactNode;
  if (q.isPending)
    body = (
      <div className="space-y-3 p-5" aria-busy="true">
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-6 w-2/3" />
      </div>
    );
  else if (!data)
    body = (
      <div className="p-5">
        <ErrorState error={q.error} onRetry={() => void q.refetch()} compact />
      </div>
    );
  else if (data.items.length === 0)
    body = (
      <p className="px-5 py-4 text-sm text-fg-muted">
        Nothing is set in the console. Every value follows .pkey/.
      </p>
    );
  else
    body = (
      <ul className="divide-y divide-border">
        {data.items.map((item) => (
          <DriftRow
            key={item.key}
            item={item}
            kept={kept.has(item.key)}
            onRevert={() => setReverting(item)}
            onKeep={() => keep(item)}
          />
        ))}
      </ul>
    );

  const warnings = data?.lastPlan?.plan.warnings ?? [];
  const differing = data?.items.filter((i) => i.differs).length ?? 0;

  return (
    <SettingsSection
      id="settings-drift"
      title="Differs from the manifest"
      description={
        data?.snapshot ? (
          <>
            Set against the manifest applied{" "}
            <Timestamp
              at={fromSeconds(data.snapshot.appliedAt)}
              format="date"
            />
            {data.snapshot.appliedSha
              ? `, ${data.snapshot.appliedSha.slice(0, 7)}`
              : ""}
            .
          </>
        ) : (
          "No manifest has been applied since claims were recorded."
        )
      }
      actions={
        data && data.items.length > 0 ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-fg-muted">
            <GitCompareArrows aria-hidden className="size-4" />
            {differing === 0
              ? "All match"
              : `${formatCount(differing)} of ${formatCount(data.items.length)} ${differing === 1 ? "differs" : "differ"}`}
          </span>
        ) : undefined
      }
    >
      {body}
      {warnings.length > 0 ? (
        <div className="px-5 pb-4">
          <Callout
            tone="warning"
            title={`${formatCount(warnings.length)} ${warnings.length === 1 ? "warning" : "warnings"} in the last apply`}
          >
            <ul className="list-disc space-y-0.5 ps-5">
              {warnings.map((w) => (
                <li key={`${w.file}:${w.path}:${w.code}`}>{w.message}</li>
              ))}
            </ul>
          </Callout>
        </div>
      ) : null}
      {reverting ? (
        isClaimKey(reverting) ? (
          <RevertClaimDialog
            slug={slug}
            claim={reverting.key as ClaimKey}
            change={driftChange(reverting)}
            onOpenChange={(open) => {
              if (!open) setReverting(null);
            }}
          />
        ) : (
          <RevertSettingDialog
            slug={slug}
            item={reverting}
            onOpenChange={(open) => {
              if (!open) setReverting(null);
            }}
          />
        )
      ) : null}
    </SettingsSection>
  );
}
