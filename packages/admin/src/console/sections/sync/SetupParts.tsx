/**
 * The parts of Cloud Sync → Setup that read one fact each: the tier rows, the product's total
 * (the meter and its words), what syncs, and the small shared pieces. Split from
 * `CloudSyncSetup.tsx`, which owns the page, its reads and its dialogs.
 */

import * as React from "react";
import { ArrowRight, CircleAlert, Lock, TriangleAlert } from "lucide-react";
import type {
  ProductCatalog,
  ProductSetting,
  SyncUsageResponse,
} from "../../../api.js";
import { cn } from "../../../lib/cn.js";
import { CLOUD_SYNC_DEFAULTS, cloudSyncEncryption } from "@polaris-key/catalog";
import { ENCRYPTION_LABEL } from "../../../lib/encryption.js";
import { formatCount } from "../../../lib/format.js";
import { DescriptionList } from "../../../ui/DescriptionList.js";
import { Button } from "../../../ui/Button.js";
import { FillRect } from "../../../ui/charts/FillRect.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { Skeleton } from "../../../ui/Skeleton.js";
import { StatusPill } from "../../../ui/StatusPill.js";
import { Link } from "../../router.js";
import { r } from "../../routes.js";
import { SettingsSection } from "../../templates/Settings.js";
import { localSettings, userSettings } from "./data.js";
import { formatBinaryBytes } from "./pages/SyncData.js";

const people = (n: number): string =>
  n === 1 ? "1 person" : `${formatCount(n)} people`;

export type Usage = Extract<SyncUsageResponse, { enabled: true }>;

export function PlatformPill(): React.ReactElement {
  return (
    <StatusPill tone="neutral" icon={false} size="sm">
      Platform
    </StatusPill>
  );
}

/** One line of "who can change this", with the lock, for a member without the access. */
export function WhoLine({ text }: { text: string }): React.ReactElement {
  return (
    <p className="flex min-w-0 items-start gap-2 text-sm text-fg-muted [overflow-wrap:anywhere]">
      <Lock aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0">{text}</span>
    </p>
  );
}

/** A block of placeholder rows while a read loads: the page does not jump when it arrives. */
export function RowsSkeleton({
  rows,
  tall = false,
}: {
  rows: number;
  /** As tall as a tier row (a name over its note), so the card does not grow when they land. */
  tall?: boolean;
}): React.ReactElement {
  return (
    <div
      data-skeleton
      aria-hidden
      className={cn(
        "pk-skeleton-group",
        tall ? "divide-y divide-border" : "space-y-3 py-1",
      )}
    >
      {Array.from({ length: rows }, (_, i) =>
        tall ? (
          <div key={i} className="flex items-center justify-between gap-4 py-3">
            <div className="space-y-1">
              <Skeleton className="h-6 w-40 max-w-full" />
              <Skeleton className="h-5 w-28 max-w-full" />
            </div>
            <Skeleton className="h-6 w-20" />
          </div>
        ) : (
          <div key={i} className="flex items-center justify-between gap-4">
            <Skeleton className="h-5 w-40 max-w-[50%]" />
            <Skeleton className="h-5 w-20" />
          </div>
        ),
      )}
    </div>
  );
}

/** The bar's share and the words that say what it means: never colour alone. */
function ceilingStatus(
  used: number,
  max: number,
): { tone: "accent" | "warning" | "danger"; words: string | null } {
  if (max <= 0 || used >= max)
    return { tone: "danger", words: "At the ceiling: saves are refused" };
  if (used / max >= 0.8) return { tone: "warning", words: "Near the ceiling" };
  return { tone: "accent", words: null };
}

const FILL = {
  accent: "fill-accent",
  warning: "fill-warning",
  danger: "fill-danger",
} as const;

/**
 * The product's total: "18.4 GiB of 50 GiB · 37%" at body size, the status in words, then the
 * bar. Its own placeholder while it loads and its own error with Retry when it fails.
 */
export function TotalStorage({
  ceilingQuery,
  ceiling,
  usage,
  usageError,
  onRetryUsage,
  canEdit,
  whoText,
  onChange,
}: {
  ceilingQuery: {
    isPending: boolean;
    isError: boolean;
    error: unknown;
    refetch: () => unknown;
  };
  ceiling: ProductSetting | undefined;
  usage: Usage | null;
  usageError: unknown;
  onRetryUsage: () => void;
  canEdit: boolean;
  whoText: string | undefined;
  onChange: () => void;
}): React.ReactElement | null {
  if (ceilingQuery.isPending) return <RowsSkeleton rows={2} />;
  if (ceilingQuery.isError)
    return (
      <ErrorState
        compact
        thing="The storage ceiling"
        error={ceilingQuery.error}
        onRetry={() => void ceilingQuery.refetch()}
      />
    );
  if (!ceiling) return null;
  const max = Number(ceiling.value);
  const maxText = max === 0 ? "0 GiB" : formatBinaryBytes(max);
  const used = usage ? usage.usage.bytes : null;
  const status = used === null ? null : ceilingStatus(used, max);
  const reading =
    used === null
      ? maxText
      : `${formatBinaryBytes(used)} of ${maxText}${max > 0 ? ` · ${Math.round((used / max) * 100)}%` : ""}`;
  const valueText =
    used === null ? undefined : `${formatBinaryBytes(used)} of ${maxText}`;
  const ratio = used === null || max <= 0 ? (used ? 1 : 0) : used / max;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 grow basis-full sm:basis-48">
          <p className="font-medium text-fg-strong">Total storage</p>
          <p className="text-sm text-fg-muted">
            {ceiling.source === "default"
              ? "Platform default"
              : "Set for this product"}
          </p>
        </div>
        {canEdit ? (
          <Button
            variant="ghost"
            size="sm"
            aria-label="Change total storage"
            onClick={onChange}
          >
            Change…
          </Button>
        ) : null}
      </div>
      <div
        role={used === null ? undefined : "meter"}
        aria-label={used === null ? undefined : "Total storage"}
        aria-valuenow={used ?? undefined}
        aria-valuemin={used === null ? undefined : 0}
        aria-valuemax={used === null ? undefined : max}
        aria-valuetext={valueText}
        className="space-y-1.5"
      >
        <p className="tabular-nums text-fg-strong [overflow-wrap:anywhere]">
          {reading}
        </p>
        {status?.words ? (
          <p
            className={cn(
              "flex items-center gap-1.5 text-sm",
              status.tone === "danger" ? "text-danger" : "text-warning",
            )}
          >
            {status.tone === "danger" ? (
              <CircleAlert aria-hidden className="size-4 shrink-0" />
            ) : (
              <TriangleAlert aria-hidden className="size-4 shrink-0" />
            )}
            {status.words}
          </p>
        ) : null}
        {status ? (
          <svg
            aria-hidden
            width="100%"
            height="6"
            className="block forced-color-adjust-none"
          >
            <rect
              width="100%"
              height="6"
              rx="3"
              className="fill-border forced-colors:fill-[Canvas] forced-colors:stroke-[CanvasText]"
            />
            <FillRect
              ratio={Math.min(Math.max(ratio, 0), 1)}
              height={6}
              rx={3}
              className={cn(
                FILL[status.tone],
                "forced-colors:fill-[Highlight]",
              )}
            />
          </svg>
        ) : null}
      </div>
      {usageError ? (
        <ErrorState
          compact
          thing="Usage"
          error={usageError}
          onRetry={onRetryUsage}
        />
      ) : null}
      {!canEdit && whoText ? <WhoLine text={whoText} /> : null}
    </div>
  );
}

/**
 * One row per tier, read-only (a tier's value is set on Tiers, which each name links to): its
 * storage, or "Uses the default"; "N people over 80%" only where N is above zero. Then people
 * without a license, from the catalog's constant.
 */
export function TierRows({
  slug,
  usage,
  defaultBytes,
}: {
  slug: string;
  usage: Usage | null;
  defaultBytes: number;
}): React.ReactElement {
  const over = (id: string): number =>
    usage?.usage.breakdown.byTier.find((t) => t.tierId === id)?.over80 ?? 0;
  return (
    <ul className="divide-y divide-border border-t border-border">
      {(usage?.tiers ?? []).map((t) => {
        const n = over(t.id);
        return (
          <li
            key={t.id}
            className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3"
          >
            <div className="min-w-0 grow basis-full sm:basis-48">
              <p className="font-medium text-fg-strong [overflow-wrap:anywhere]">
                <Link
                  to={r.tier(slug, t.id)}
                  className="py-1 hover:underline underline-offset-2"
                >
                  <bdi>{t.label}</bdi>
                </Link>
              </p>
              {t.bytes === null ? (
                <p className="text-sm text-fg-muted">Uses the default</p>
              ) : null}
              {n > 0 ? (
                <p className="text-sm text-warning">{people(n)} over 80%</p>
              ) : null}
            </div>
            <p className="tabular-nums text-fg-strong">
              {formatBinaryBytes(t.bytes ?? defaultBytes)}
            </p>
          </li>
        );
      })}
      <li className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3">
        <div className="min-w-0 grow basis-full sm:basis-48">
          <p className="font-medium text-fg-strong">Without a license</p>
        </div>
        <p className="tabular-nums text-fg-strong">
          {formatBinaryBytes(CLOUD_SYNC_DEFAULTS.unlicensedQuotaBytes)}, no
          files
        </p>
      </li>
    </ul>
  );
}

const FIRST_KEYS = 8;

/** What syncs, read from the catalog: the keys, the two that stay on each device, the limits. */
export function WhatSyncs({
  slug,
  catalog,
}: {
  slug: string;
  catalog: ProductCatalog;
}): React.ReactElement {
  const synced = userSettings(catalog);
  const local = localSettings(catalog);
  const shown = synced.slice(0, FIRST_KEYS);
  return (
    <SettingsSection
      id="sync-what"
      title="What syncs"
      description={
        <>
          From the catalog, v{catalog.schemaVersion}.{" "}
          <Link
            to={r.catalog(slug)}
            className="py-1 text-accent-fg underline underline-offset-2"
          >
            Open the catalog
          </Link>
        </>
      }
    >
      <div className="space-y-4 px-5 py-4 text-sm">
        <div className="space-y-1">
          <p className="font-medium text-fg-strong">
            Settings: {formatCount(synced.length)} sync
          </p>
          {synced.length > 0 ? (
            <p className="text-fg">
              {shown.map((e, i) => (
                <React.Fragment key={e.key}>
                  {i > 0 ? ", " : null}
                  <code className="font-mono text-xs text-fg-strong">
                    {e.key}
                  </code>
                </React.Fragment>
              ))}
              {synced.length > shown.length
                ? ` and ${formatCount(synced.length - shown.length)} more`
                : null}
            </p>
          ) : null}
          {local.length > 0 ? (
            <p className="text-fg-muted">
              {formatCount(local.length)} stay on each device:{" "}
              {local.map((k, i) => (
                <React.Fragment key={k}>
                  {i > 0 ? ", " : null}
                  <code className="font-mono text-xs">{k}</code>
                </React.Fragment>
              ))}
            </p>
          ) : null}
          <p className="text-fg-muted">Keys the app adds itself also sync.</p>
        </div>
        <DescriptionList
          columns={2}
          items={[
            {
              term: "Encryption",
              detail: ENCRYPTION_LABEL[cloudSyncEncryption(catalog)],
            },
            {
              term: "Keys per person",
              detail: `Up to ${formatCount(CLOUD_SYNC_DEFAULTS.settings.maxKeys)}`,
            },
            {
              term: "Size per person",
              detail: `Up to ${formatBinaryBytes(CLOUD_SYNC_DEFAULTS.settings.maxBytes)}`,
            },
          ]}
        />
      </div>
    </SettingsSection>
  );
}
