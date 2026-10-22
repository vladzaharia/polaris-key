/**
 * Cloud Sync → Usage (config.cloud-sync-usage; U-05.20). Read-only, from the directory's own
 * aggregate (`GET …/sync/usage`, U-05.19): the console computes nothing from it and shows no
 * person, subject or device. Counts and bytes, in MiB and GiB.
 *
 * A game says "player" and an app "person"; which one the product is comes from its catalog (a
 * `saves` collection means a game), never from a product name (rule 5).
 *
 * Nothing here depends on colour: every tile, row and bar segment carries its label and value in
 * text, and the bar has a text alternative that lists the same sizes.
 */

import * as React from "react";
import { TriangleAlert } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api, type SyncUsageResponse } from "../../../../api.js";
import { cn } from "../../../../lib/cn.js";
import {
  formatCount,
  formatRelative,
  fromSeconds,
} from "../../../../lib/format.js";
import { platformName } from "../../../../lib/vocab/platforms.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { PageSkeleton } from "../../../../ui/Skeleton.js";
import { StatTile } from "../../../../ui/charts/StatTile.js";
import { useProduct } from "../../../data/hooks.js";
import { qk } from "../../../data/queries.js";
import { Link } from "../../../router.js";
import { r } from "../../../routes.js";
import { Panel } from "../../../templates/Dashboard.js";
import { declaresSaves } from "../data.js";
import { SyncHeader } from "../SyncHeader.js";

type Usage = Extract<SyncUsageResponse, { enabled: true }>;

const NBSP = "\u00a0";
const KiB = 1024;
const UNITS = ["bytes", "KiB", "MiB", "GiB", "TiB"] as const;

/**
 * Binary bytes with one decimal, the unit kept with its number (a non-breaking space):
 * 19_791_209_299 → "18.4 GiB", 0 → "0 bytes". A value that rounds up to the next unit moves to it.
 */
export function formatStorage(bytes: number): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (unit < UNITS.length - 1 && Math.round(value * 10) / 10 >= KiB) {
    value /= KiB;
    unit++;
  }
  const text =
    unit === 0
      ? formatCount(Math.round(value))
      : new Intl.NumberFormat("en", {
          minimumFractionDigits: 0,
          maximumFractionDigits: 1,
        }).format(value);
  return `${text}${NBSP}${UNITS[unit]}`;
}

/** "player" for a game, "person" for an app. */
export function nounsFor(game: boolean): { one: string; many: string } {
  return game
    ? { one: "player", many: "players" }
    : { one: "person", many: "people" };
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

export function SyncUsagePage({ slug }: { slug: string }): React.ReactElement {
  const product = useProduct(slug);
  const off = product.data?.services?.sync?.enabled === false;
  const usage = useQuery({
    queryKey: qk.syncUsage(slug),
    queryFn: () => api.syncUsage(slug),
    retry: false,
    enabled: !off && !product.isPending,
  });
  const catalog = useQuery({
    queryKey: qk.catalog(slug),
    queryFn: () => api.schema(slug),
    retry: false,
    enabled: !off && !product.isPending,
  });
  const nouns = nounsFor(declaresSaves(catalog.data ?? null));

  const header = (
    <SyncHeader
      slug={slug}
      tab="sync-usage"
      refetching={usage.isFetching && !usage.isPending}
    />
  );

  let body: React.ReactNode;
  if (off || (usage.data && !usage.data.enabled)) {
    body = <SyncOff slug={slug} />;
  } else if (usage.isPending) {
    body = <PageSkeleton template="record" label="Cloud Sync usage" />;
  } else if (usage.isError) {
    body = (
      <ErrorState
        error={usage.error}
        onRetry={() => void usage.refetch()}
        thing="Usage"
      />
    );
  } else if (usage.data.enabled) {
    body =
      usage.data.usage.people === 0 ? (
        <EmptyState
          kind="first-run"
          headingLevel={2}
          title={`No ${nouns.many} have synced yet`}
          description={`Usage appears once a signed-in ${nouns.one} syncs from the app.`}
        />
      ) : (
        <UsageBody data={usage.data} nouns={nouns} slug={slug} />
      );
  }

  return (
    <div className="space-y-6" data-template="record">
      {header}
      {body}
    </div>
  );
}

function SyncOff({ slug }: { slug: string }): React.ReactElement {
  return (
    <EmptyState
      kind="service-off"
      service="sync"
      headingLevel={2}
      title="Cloud Sync is off for this product"
      description="Settings stay on each device and nothing syncs until Cloud Sync is on."
      primaryAction={
        <Link
          to={r.services(slug)}
          className="py-1 text-accent-fg underline underline-offset-2"
        >
          Open Features
        </Link>
      }
    />
  );
}

const th =
  "px-4 py-3 text-start text-xs font-semibold text-fg-strong max-sm:sr-only";
// Phone: each row becomes a block, every cell under its own label.
const td =
  "px-4 py-3 align-middle text-sm max-sm:flex max-sm:flex-wrap max-sm:gap-x-3 max-sm:py-1 max-sm:before:flex-1 max-sm:before:text-xs max-sm:before:text-fg-muted max-sm:before:content-[attr(data-label)]";
const num = "tabular-nums sm:text-end";
const nowrap = "sm:whitespace-nowrap";

function UsageBody({
  data,
  nouns,
  slug,
}: {
  data: Usage;
  nouns: { one: string; many: string };
  slug: string;
}): React.ReactElement {
  const { usage, today } = data;
  const Many = cap(nouns.many);
  const updated = usage.computedAt
    ? `Updated ${formatRelative(fromSeconds(usage.computedAt))}`
    : undefined;
  return (
    <>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,9rem),1fr))] gap-3 xl:grid-cols-4">
        <StatTile
          label={`${Many} with data`}
          value={formatCount(usage.people)}
          secondary={updated}
        />
        <StatTile label="Storage used" value={formatStorage(usage.bytes)} />
        <StatTile
          label="Syncs today"
          value={formatCount(today.syncs)}
          secondary="Since 00:00 UTC"
        />
        <StatTile
          label="Conflicts today"
          value={formatCount(today.conflicts)}
          secondary="Since 00:00 UTC"
        />
      </div>

      <TierPanel data={data} nouns={nouns} slug={slug} />

      <div className="grid gap-6 min-[1100px]:grid-cols-[2fr_1fr]">
        <StoredPanel usage={usage} nouns={nouns} />
        <PlatformPanel data={data} nouns={nouns} />
      </div>
    </>
  );
}

interface TierRow {
  key: string;
  label: string;
  sub: string;
  people: number;
  bytes: number;
  median: number | null;
  over80: number;
}

function tierRows(data: Usage): TierRow[] {
  const { tiers, defaultBytes } = data;
  const by = new Map(
    data.usage.breakdown.byTier.map((t) => [t.tierId ?? "", t]),
  );
  const rows: TierRow[] = tiers.map((t) => {
    const b = by.get(t.id);
    by.delete(t.id);
    return {
      key: t.id,
      label: t.label,
      sub:
        t.bytes === null
          ? `${formatStorage(defaultBytes)} each, the default`
          : `${formatStorage(t.bytes)} each`,
      people: b?.people ?? 0,
      bytes: b?.bytes ?? 0,
      median: b ? b.medianBytes : null,
      over80: b?.over80 ?? 0,
    };
  });
  // What the tiers list no longer holds: the no-license row and a tier removed since.
  for (const [id, b] of by) {
    if (!id && b.people === 0) continue;
    rows.push({
      key: id || "none",
      label: id || "Without a license",
      sub: id ? `${formatStorage(defaultBytes)} each, the default` : "",
      people: b.people,
      bytes: b.bytes,
      median: b.medianBytes,
      over80: b.over80,
    });
  }
  return rows;
}

function TierPanel({
  data,
  nouns,
  slug,
}: {
  data: Usage;
  nouns: { one: string; many: string };
  slug: string;
}): React.ReactElement {
  const rows = tierRows(data);
  return (
    <Panel
      title="Storage by tier"
      action={
        <Link
          to={r.syncSetup(slug)}
          className="py-1 text-accent-fg underline underline-offset-2"
        >
          Change on Setup
        </Link>
      }
    >
      <div
        role="region"
        aria-label="Storage by tier table"
        tabIndex={0}
        className="pk-scroll -m-5 overflow-x-auto"
      >
        <table className="w-full table-fixed border-collapse max-sm:block">
          <caption className="sr-only">Storage by tier</caption>
          <colgroup className="max-sm:hidden">
            <col className="w-[30%]" />
            <col className="w-[14%]" />
            <col className="w-[14%]" />
            <col className="w-[14%]" />
            <col className="w-[28%]" />
          </colgroup>
          <thead className="max-sm:contents">
            <tr className="border-b border-border max-sm:sr-only">
              <th scope="col" className={th}>
                Tier
              </th>
              <th scope="col" className={cn(th, "sm:text-end")}>
                {cap(nouns.many)} with data
              </th>
              <th scope="col" className={cn(th, "sm:text-end")}>
                Storage used
              </th>
              <th scope="col" className={cn(th, "sm:text-end")}>
                Median per {nouns.one}
              </th>
              <th scope="col" className={th}>
                Over 80 % of the limit
              </th>
            </tr>
          </thead>
          <tbody className="max-sm:block">
            {rows.map((t) => (
              <tr
                key={t.key}
                className="border-b border-border last:border-b-0 max-sm:block max-sm:py-2"
              >
                <th
                  scope="row"
                  className="px-4 py-3 text-start align-middle text-sm font-normal max-sm:block max-sm:py-1"
                >
                  <div className="font-medium text-fg-strong [overflow-wrap:anywhere]">
                    {t.label}
                  </div>
                  {t.sub ? (
                    <div className="text-xs text-fg-muted">{t.sub}</div>
                  ) : null}
                </th>
                <td
                  data-label={`${cap(nouns.many)} with data`}
                  className={cn(td, num)}
                >
                  <span className="max-sm:ms-auto">
                    {formatCount(t.people)}
                  </span>
                </td>
                <td data-label="Storage used" className={cn(td, num, nowrap)}>
                  <span className="max-sm:ms-auto">
                    {formatStorage(t.bytes)}
                  </span>
                </td>
                <td
                  data-label={`Median per ${nouns.one}`}
                  className={cn(td, num, nowrap)}
                >
                  <span className="max-sm:ms-auto">
                    {t.median === null ? "None" : formatStorage(t.median)}
                  </span>
                </td>
                <td data-label="Over 80 %" className={td}>
                  {t.over80 > 0 ? (
                    <span className="inline-flex items-center gap-1.5 text-warning max-sm:ms-auto">
                      <TriangleAlert aria-hidden className="size-4 shrink-0" />
                      <span>
                        {formatCount(t.over80)}{" "}
                        {t.over80 === 1 ? nouns.one : nouns.many} over 80 %
                      </span>
                    </span>
                  ) : (
                    <span className="text-fg-muted max-sm:ms-auto">None</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

const KINDS = [
  { key: "settings", label: "Settings", swatch: "bg-fg-strong" },
  { key: "records", label: "Records", swatch: "bg-fg-muted" },
  { key: "files", label: "Files", swatch: "bg-fg-subtle" },
  { key: "revisions", label: "Older versions", swatch: "bg-border-strong" },
] as const;

function StoredPanel({
  usage,
  nouns,
}: {
  usage: Usage["usage"];
  nouns: { one: string; many: string };
}): React.ReactElement {
  const sizes = {
    settings: usage.settingsBytes,
    records: usage.recordBytes,
    files: usage.fileBytes,
    revisions: usage.revisionBytes,
  };
  const total = KINDS.reduce((a, k) => a + sizes[k.key], 0);
  const alt = KINDS.map(
    (k) => `${k.label} ${formatStorage(sizes[k.key])}`,
  ).join(", ");
  return (
    <Panel title="What's stored" className="min-w-0">
      <div className="space-y-4">
        <div
          role="img"
          aria-label={alt}
          className="flex h-3 max-w-[640px] gap-0.5 overflow-hidden rounded-full bg-surface-sunken"
        >
          {total > 0
            ? KINDS.filter((k) => sizes[k.key] > 0).map((k) => (
                <i
                  key={k.key}
                  className={cn("block h-full min-w-1", k.swatch)}
                  style={{ width: `${(sizes[k.key] / total) * 100}%` }}
                />
              ))
            : null}
        </div>
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">What's stored</caption>
          <thead>
            <tr className="border-b border-border">
              <th
                scope="col"
                className="py-2 pe-4 text-start text-xs font-semibold text-fg-strong"
              >
                Kind
              </th>
              <th
                scope="col"
                className="py-2 text-end text-xs font-semibold text-fg-strong"
              >
                Size
              </th>
            </tr>
          </thead>
          <tbody>
            {KINDS.map((k) => (
              <tr
                key={k.key}
                className="border-b border-border last:border-b-0"
              >
                <th scope="row" className="py-2 pe-4 text-start font-normal">
                  <span className="flex items-center gap-2">
                    <i
                      aria-hidden
                      className={cn("size-3 shrink-0 rounded-[3px]", k.swatch)}
                    />
                    <span>{k.label}</span>
                  </span>
                </th>
                <td className="py-2 text-end tabular-nums whitespace-nowrap">
                  {formatStorage(sizes[k.key])}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-xs text-fg-muted">
          Older versions count toward each {nouns.one}'s storage.
        </p>
      </div>
    </Panel>
  );
}

function PlatformPanel({
  data,
  nouns,
}: {
  data: Usage;
  nouns: { one: string; many: string };
}): React.ReactElement {
  const rows = data.usage.breakdown.byPlatform;
  return (
    <Panel
      title={`Where ${nouns.many} sync from`}
      description="This week"
      className="min-w-0"
    >
      {rows.length === 0 ? (
        <p className="text-sm text-fg-muted">No platform has synced yet.</p>
      ) : (
        <div
          role="region"
          aria-label="Platforms table"
          tabIndex={0}
          className="pk-scroll overflow-x-auto"
        >
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">
              {cap(nouns.many)} per platform
            </caption>
            <thead>
              <tr className="border-b border-border">
                <th
                  scope="col"
                  className="py-2 pe-4 text-start text-xs font-semibold text-fg-strong"
                >
                  Platform
                </th>
                <th
                  scope="col"
                  className="py-2 pe-4 text-end text-xs font-semibold text-fg-strong"
                >
                  {cap(nouns.many)}
                </th>
                <th
                  scope="col"
                  className="py-2 text-end text-xs font-semibold text-fg-strong"
                >
                  Last sync
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr
                  key={p.platform ?? "unknown"}
                  className="border-b border-border last:border-b-0"
                >
                  <th scope="row" className="py-2 pe-4 text-start font-normal">
                    {p.platform ? platformName(p.platform) : "Not reported"}
                  </th>
                  <td className="py-2 pe-4 text-end tabular-nums">
                    {formatCount(p.peopleThisWeek)}
                  </td>
                  <td className="py-2 text-end tabular-nums text-fg-muted whitespace-nowrap">
                    {p.lastSyncAt
                      ? formatRelative(fromSeconds(p.lastSyncAt))
                      : "Never"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
