/**
 * Cloud Sync → Usage's tables and panels (U-05.20): storage by tier, what's stored, where people
 * sync from. Split from the page for the section page budget; counts and bytes only.
 */

import * as React from "react";
import { TriangleAlert } from "lucide-react";
import { resolveCollection } from "@polaris-key/catalog";
import type { ProductCatalog, SyncUsageResponse } from "../../../../api.js";
import { cn } from "../../../../lib/cn.js";
import {
  formatCount,
  formatRelative,
  fromSeconds,
} from "../../../../lib/format.js";
import { platformName } from "../../../../lib/vocab/platforms.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { StatTile } from "../../../../ui/charts/StatTile.js";
import { useOverflows } from "../../../../ui/data-table/DataTable.js";
import { useCan } from "../../../access/useCan.js";
import { Link } from "../../../router.js";
import { r } from "../../../routes.js";
import { Panel } from "../../../templates/Dashboard.js";
import { formatBinaryBytes } from "./SyncData.js";

export type Usage = Extract<SyncUsageResponse, { enabled: true }>;
export type Nouns = { one: string; many: string };

const NBSP = "\u00a0";

export const TILES =
  "grid grid-cols-[repeat(auto-fit,minmax(min(100%,9rem),1fr))] gap-3";

/** Stat tiles and a table card while a usage read loads: the page's own shape, no second header. */
export function UsageSkeleton({
  tiles,
}: {
  tiles: number;
}): React.ReactElement {
  return (
    <div className="space-y-6" aria-busy="true">
      <p role="status" className="sr-only">
        Loading usage
      </p>
      <div aria-hidden className={TILES}>
        {Array.from({ length: tiles }, (_, k) => (
          <StatTile key={k} label="Loading" loading />
        ))}
      </div>
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  );
}

/** The one Cloud Sync byte formatter (Setup's), with the unit kept to its number. */
export function formatStorage(bytes: number): string {
  return formatBinaryBytes(Math.max(0, bytes)).replace(" ", NBSP);
}

/** "player" for a game, "person" for an app. */
export function nounsFor(game: boolean): Nouns {
  return game
    ? { one: "player", many: "players" }
    : { one: "person", many: "people" };
}

export const cap = (s: string): string =>
  s.charAt(0).toUpperCase() + s.slice(1);

// `content: attr() / ""` keeps the phone label out of the cell's accessible name.
export const LABEL =
  'max-sm:before:flex-1 max-sm:before:text-start max-sm:before:text-xs max-sm:before:text-fg-muted max-sm:before:content-[attr(data-label)_/_""]';
const th =
  "px-4 py-3 text-start text-xs font-semibold text-fg-strong max-sm:sr-only";
// Phone: each row becomes a block, every cell under its own label.
const td = `px-4 py-3 align-middle text-sm max-sm:flex max-sm:flex-wrap max-sm:gap-x-3 max-sm:py-1 ${LABEL}`;
const num = "tabular-nums sm:text-end";
const nowrap = "sm:whitespace-nowrap";
const rowHead =
  "px-4 py-3 text-start align-middle text-sm font-normal max-sm:block max-sm:py-1";

interface TierRow {
  key: string;
  label: string;
  sub: string;
  people: number;
  bytes: number;
  median: number | null;
  over80: number;
}

function tierRows(data: Usage, licensing: boolean): TierRow[] {
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
  for (const [id, b] of by) {
    // The null tier holds people with no tier, and (until the read separates them) people with
    // no license: no limit line, except when Licensing is off and everyone is on the default.
    if (!id && b.people === 0) continue;
    rows.push({
      key: id || "none",
      label: id || "No tier",
      sub: id
        ? "Removed tier"
        : licensing
          ? ""
          : `${formatStorage(defaultBytes)} each, the default`,
      people: b.people,
      bytes: b.bytes,
      median: b.medianBytes,
      over80: b.over80,
    });
  }
  return rows;
}

/** A scroller that is a tab stop only while it overflows. */
export function Scroller({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}): React.ReactElement {
  const ref = React.useRef<HTMLDivElement>(null);
  const over = useOverflows(ref);
  return (
    <div
      ref={ref}
      role={over ? "region" : undefined}
      aria-label={over ? label : undefined}
      tabIndex={over ? 0 : undefined}
      className={cn("pk-scroll overflow-x-auto", className)}
    >
      {children}
    </div>
  );
}

export function TierPanel({
  data,
  nouns,
  slug,
  licensing,
  className,
}: {
  data: Usage;
  nouns: Nouns;
  slug: string;
  licensing: boolean;
  className?: string;
}): React.ReactElement {
  const rows = tierRows(data, licensing);
  const canSet = useCan("platform", null, "edit");
  return (
    <Panel
      title="Storage by tier"
      className={className}
      action={
        canSet ? (
          <Link
            to={r.syncSetup(slug)}
            className="py-1 text-accent-fg underline underline-offset-2"
          >
            Set the default on Setup
          </Link>
        ) : undefined
      }
    >
      <Scroller label="Storage by tier table" className="-m-5">
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
                Over 80 %
              </th>
            </tr>
          </thead>
          <tbody className="max-sm:block">
            {rows.map((t) => (
              <tr
                key={t.key}
                className="border-b border-border last:border-b-0 max-sm:block max-sm:py-2"
              >
                <th scope="row" className={rowHead}>
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
                        {t.over80 === 1 ? nouns.one : nouns.many}
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
      </Scroller>
    </Panel>
  );
}

const KINDS = [
  { key: "settings", label: "Settings", swatch: "bg-fg-strong" },
  { key: "records", label: "Records", swatch: "bg-fg-muted" },
  { key: "files", label: "Files", swatch: "bg-fg-subtle" },
  { key: "revisions", label: "Older versions", swatch: "bg-border-strong" },
] as const;

/** What the catalog declares: records when it has collections, files when a collection holds them. */
function declared(catalog: ProductCatalog | null): {
  records: boolean;
  files: boolean;
} {
  const cols = (catalog?.cloudSync?.collections ?? []).map(resolveCollection);
  return {
    records: cols.length > 0,
    files: cols.some((c) => c.files.maxBytes > 0),
  };
}

/** The kinds "What's stored" lists, and whether it draws a bar (two or more kinds hold bytes). */
export function storedKinds(
  usage: Usage["usage"],
  catalog: ProductCatalog | null,
) {
  const sizes = {
    settings: usage.settingsBytes,
    records: usage.recordBytes,
    files: usage.fileBytes,
    revisions: usage.revisionBytes,
  };
  const decl = declared(catalog);
  // A kind is listed when it holds bytes or the catalog declares it; settings always.
  const shown = KINDS.filter(
    (k) =>
      k.key === "settings" ||
      sizes[k.key] > 0 ||
      (k.key === "records" && decl.records) ||
      (k.key === "files" && decl.files),
  );
  const total = shown.reduce((a, k) => a + sizes[k.key], 0);
  const withBytes = shown
    .filter((k) => sizes[k.key] > 0)
    .sort((a, b) => sizes[b.key] - sizes[a.key]);
  // One kind is the whole bar: the table says it, the bar would only repeat the total.
  return { sizes, shown, withBytes, total, bar: withBytes.length >= 2 };
}

export function StoredPanel({
  usage,
  nouns,
  catalog,
  className,
}: {
  usage: Usage["usage"];
  nouns: Nouns;
  catalog: ProductCatalog | null;
  className?: string;
}): React.ReactElement {
  const { sizes, shown, withBytes, total, bar } = storedKinds(usage, catalog);
  const lead = withBytes[0];
  const summary =
    bar && lead
      ? `${lead.label} are ${Math.round((sizes[lead.key] / total) * 100)} % of ${formatStorage(total)}`
      : "";
  return (
    <Panel title="What's stored" className={cn("min-w-0", className)}>
      <div className="flex h-full flex-col gap-4">
        {bar ? (
          <div
            role="img"
            aria-label={summary}
            className="flex h-3 max-w-[640px] gap-0.5 overflow-hidden rounded-full bg-surface-raised"
          >
            {withBytes.map((k) => (
              <i
                key={k.key}
                className={cn("block h-full min-w-1", k.swatch)}
                style={{ width: `${(sizes[k.key] / total) * 100}%` }}
              />
            ))}
          </div>
        ) : null}
        <table className="w-full max-w-[640px] border-collapse text-sm max-sm:block">
          <caption className="sr-only">What's stored</caption>
          <thead className="max-sm:contents">
            <tr className="border-b border-border max-sm:sr-only">
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
          <tbody className="max-sm:block">
            {shown.map((k) => (
              <tr
                key={k.key}
                className="border-b border-border last:border-b-0 max-sm:flex max-sm:items-baseline max-sm:justify-between max-sm:gap-3"
              >
                <th
                  scope="row"
                  className="py-2 pe-4 text-start font-normal max-sm:min-w-0 max-sm:flex-1"
                >
                  <span className="flex items-center gap-2">
                    {bar ? (
                      <i
                        aria-hidden
                        className={cn(
                          "size-3 shrink-0 rounded-[3px]",
                          k.swatch,
                        )}
                      />
                    ) : null}
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
        {sizes.revisions > 0 ? (
          <p className="mt-auto text-xs text-fg-muted">
            Older versions count toward each {nouns.one}'s storage.
          </p>
        ) : null}
      </div>
    </Panel>
  );
}

export function PlatformPanel({
  data,
  nouns,
  className,
}: {
  data: Usage;
  nouns: Nouns;
  className?: string;
}): React.ReactElement {
  // Display order only: most people this week first, "Not reported" last.
  const rows = [...data.usage.breakdown.byPlatform].sort(
    (a, b) =>
      Number(a.platform === null) - Number(b.platform === null) ||
      b.peopleThisWeek - a.peopleThisWeek,
  );
  return (
    <Panel
      title={`Where ${nouns.many} sync from`}
      description="This week"
      className={cn("min-w-0", className)}
    >
      {rows.length === 0 ? (
        <p className="text-sm text-fg-muted">No platform has synced yet.</p>
      ) : (
        <Scroller label="Platforms table">
          <table className="w-full max-w-[640px] border-collapse text-sm max-sm:block min-[1600px]:max-w-none">
            <caption className="sr-only">
              {cap(nouns.many)} per platform
            </caption>
            <thead className="max-sm:contents">
              <tr className="border-b border-border max-sm:sr-only">
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
            <tbody className="max-sm:block">
              {rows.map((p) => (
                <tr
                  key={p.platform ?? "unknown"}
                  className="border-b border-border last:border-b-0 max-sm:block max-sm:py-2"
                >
                  <th
                    scope="row"
                    className="py-2 pe-4 text-start font-normal max-sm:block max-sm:py-1"
                  >
                    {p.platform ? platformName(p.platform) : "Not reported"}
                  </th>
                  <td
                    data-label={cap(nouns.many)}
                    className={cn(
                      "py-2 pe-4 text-end tabular-nums max-sm:pe-0 max-sm:flex max-sm:gap-x-3 max-sm:py-1",
                      LABEL,
                    )}
                  >
                    <span className="max-sm:ms-auto">
                      {formatCount(p.peopleThisWeek)}
                    </span>
                  </td>
                  <td
                    data-label="Last sync"
                    className={cn(
                      "py-2 text-end tabular-nums text-fg-muted max-sm:flex max-sm:gap-x-3 max-sm:py-1",
                      LABEL,
                    )}
                  >
                    <span className="max-sm:ms-auto">
                      {p.lastSyncAt
                        ? formatRelative(fromSeconds(p.lastSyncAt))
                        : "Never"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Scroller>
      )}
    </Panel>
  );
}
