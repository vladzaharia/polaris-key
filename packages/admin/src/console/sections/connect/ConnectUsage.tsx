/**
 * Cloud Connect → Usage (CC-16.3). Read-only, from the relay's meter (`GET …/connect/usage`): data
 * relayed and relay sessions per UTC day over 30 days, their totals and the number of people with
 * linked devices. Counters only: no person or device appears. Bytes are binary ("2.3 GiB").
 *
 * Nothing depends on colour: each tile and row carries its label and value in text, and the bars
 * are decoration beside the figures.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "../../../lib/cn.js";
import { formatCount } from "../../../lib/format.js";
import { Button } from "../../../ui/Button.js";
import { reads } from "../../data/reads.js";
import { DOCS_LINKS } from "../../../lib/docsLinks.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { StatTile } from "../../../ui/charts/StatTile.js";
import { Link } from "../../router.js";
import { r } from "../../routes.js";
import { Panel } from "../../templates/Dashboard.js";
import { Scroller, TILES, UsageSkeleton } from "../sync/pages/usageParts.js";
import { ConnectHeader } from "./ConnectHeader.js";
import { CONNECT_AREA } from "./ConnectSetup.js";
import { USAGE_DAYS, connectUsageQuery } from "./data.js";

const CEILING = "cloudConnect.ceiling.relayBytes";

const UNITS = ["KiB", "MiB", "GiB", "TiB"] as const;

/** Binary bytes to one decimal, unit kept to its number: "2.3 GiB", "512 bytes". */
function bytes(n: number): string {
  let v = Math.max(0, n);
  if (v < 1024) return `${Math.round(v)}\u00a0bytes`;
  let u = -1;
  while (v >= 1024 && u < UNITS.length - 1) {
    v /= 1024;
    u++;
  }
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(v)}\u00a0${UNITS[u]}`;
}

/** "Wed, Oct 28" for a UTC day. */
const dayLabel = (day: string): string =>
  new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${day}T00:00:00Z`));

export function ConnectUsagePage({
  slug,
}: {
  slug: string;
}): React.ReactElement {
  const usage = useQuery(connectUsageQuery(slug));
  const read = usage.data?.enabled ? usage.data : null;
  const settings = useQuery({
    ...reads.productSettings(slug, CONNECT_AREA),
    retry: false,
  });
  const ceiling = Number(
    settings.data?.settings.find((x) => x.key === CEILING)?.value,
  );
  // The read covers a whole month; the page shows and totals the last 30 days.
  const data = read && {
    ...read,
    days: read.days.slice(-USAGE_DAYS),
    totals: read.days.slice(-USAGE_DAYS).reduce(
      (t, d) => ({
        bytes: t.bytes + d.bytes,
        sessions: t.sessions + d.sessions,
      }),
      { bytes: 0, sessions: 0 },
    ),
  };
  const month = read?.days.at(-1)?.day.slice(0, 7);
  const monthBytes = (read?.days ?? [])
    .filter((d) => d.day.startsWith(month ?? "-"))
    .reduce((n, d) => n + d.bytes, 0);
  let body: React.ReactNode;
  if (usage.isPending) {
    body = <UsageSkeleton tiles={4} />;
  } else if (usage.isError) {
    body = (
      <ErrorState
        thing="Usage"
        context={{ read: true }}
        error={usage.error}
        onRetry={() => void usage.refetch()}
      />
    );
  } else if (!data || (data.totals.sessions === 0 && data.totals.bytes === 0)) {
    body = (
      <>
        {data && data.people > 0 ? (
          <div className={TILES}>
            <StatTile
              label="People with linked devices"
              value={formatCount(data.people)}
              href={r.connectDevices(slug)}
            />
          </div>
        ) : null}
        <EmptyState
          kind="first-run"
          headingLevel={2}
          docs={DOCS_LINKS.connect}
          title="No relay traffic yet"
          description="Relay traffic appears here once devices on different networks connect."
          primaryAction={
            <Button asChild variant="outline">
              <Link to={r.connectSetup(slug)}>See Setup</Link>
            </Button>
          }
        />
      </>
    );
  } else {
    const max = Math.max(1, ...data.days.map((d) => d.bytes));
    body = (
      <>
        <div className={TILES}>
          <StatTile
            label="This month"
            value={bytes(monthBytes)}
            secondary={
              Number.isFinite(ceiling)
                ? `Of ${bytes(ceiling)}, UTC month`
                : "UTC month"
            }
          />
          <StatTile
            label="Relay data"
            value={bytes(data.totals.bytes)}
            secondary={`Last ${USAGE_DAYS} days`}
            sparkline={data.days.map((d) => d.bytes)}
          />
          <StatTile
            label="Relay sessions"
            value={formatCount(data.totals.sessions)}
            secondary={`Last ${USAGE_DAYS} days`}
            sparkline={data.days.map((d) => d.sessions)}
          />
          <StatTile
            label="People with linked devices"
            value={formatCount(data.people)}
            href={r.connectDevices(slug)}
          />
        </div>
        <Panel title="Per day" description="UTC, newest first">
          <Scroller label="Per day table" className="-m-5">
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">Relay use per day</caption>
              <thead>
                <tr className="border-b border-border">
                  <th
                    scope="col"
                    className="px-4 py-2 text-start text-xs font-semibold text-fg-strong"
                  >
                    Day
                  </th>
                  <th
                    scope="col"
                    className="px-4 py-2 text-end text-xs font-semibold text-fg-strong"
                  >
                    Sessions
                  </th>
                  <th
                    scope="col"
                    className="px-4 py-2 text-end text-xs font-semibold text-fg-strong"
                  >
                    Data
                  </th>
                  <th scope="col" className="w-1/3 max-sm:hidden">
                    <span className="sr-only">Share of the busiest day</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {[...data.days].reverse().map((d) => (
                  <tr
                    key={d.day}
                    className={cn(
                      "border-b border-border last:border-b-0",
                      d.bytes === 0 && d.sessions === 0 && "text-fg-muted",
                    )}
                  >
                    <th
                      scope="row"
                      className="px-4 py-2 text-start font-normal tabular-nums"
                    >
                      <time dateTime={d.day}>{dayLabel(d.day)}</time>
                    </th>
                    <td className="px-4 py-2 text-end tabular-nums">
                      {formatCount(d.sessions)}
                    </td>
                    <td className="px-4 py-2 text-end tabular-nums whitespace-nowrap">
                      {bytes(d.bytes)}
                    </td>
                    <td aria-hidden className="py-2 pe-4 max-sm:hidden">
                      <div className="h-2 rounded-full bg-surface-raised">
                        <div
                          className="h-full rounded-full bg-accent"
                          style={{ width: `${(d.bytes / max) * 100}%` }}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Scroller>
        </Panel>
      </>
    );
  }
  return (
    <div className="space-y-6" data-template="record">
      <ConnectHeader
        slug={slug}
        tab="connect-usage"
        refetching={usage.isFetching && !usage.isPending}
      />
      {body}
    </div>
  );
}
