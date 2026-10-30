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
import { ArrowRight } from "lucide-react";
import { cn } from "../../../lib/cn.js";
import { formatCount } from "../../../lib/format.js";
import { Button } from "../../../ui/Button.js";
import { useCan } from "../../access/useCan.js";
import { reads } from "../../data/reads.js";
import { DOCS_LINKS } from "../../../lib/docsLinks.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { StatTile } from "../../../ui/charts/StatTile.js";
import { Link } from "../../router.js";
import { r } from "../../routes.js";
import { Panel } from "../../templates/Dashboard.js";
import { Scroller, TILES, UsageSkeleton } from "../sync/pages/usageParts.js";
import { MeterBar, ceilingStatus } from "../sync/SetupParts.js";
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

const LINK =
  "inline-flex min-h-6 items-center gap-1 text-accent-fg underline underline-offset-2";

/** The people tile: a count, and the way to who they are (the tile's label stays plain text). */
function PeopleTile({
  slug,
  people,
}: {
  slug: string;
  people: number;
}): React.ReactElement {
  return (
    <StatTile
      label="People with linked devices"
      value={formatCount(people)}
      secondary={
        <Link to={r.connectDevices(slug)} className={LINK}>
          Linked devices
          <ArrowRight aria-hidden className="size-3.5 rtl:-scale-x-100" />
        </Link>
      }
    />
  );
}

const WORDS = {
  warning: "Near the ceiling",
  danger: "At the ceiling: new connections are refused",
} as const;

/**
 * "This month" against the ceiling: the figure, a thin meter, and the words for the state
 * (warning tone from 80 %), then Change on Setup for a member who can edit.
 */
function CeilingNote({
  slug,
  used,
  ceiling,
}: {
  slug: string;
  used: number;
  ceiling: number;
}): React.ReactElement {
  const canEdit = useCan("connect", slug, "edit");
  const status = ceilingStatus(used, ceiling);
  const words = status.tone === "accent" ? null : WORDS[status.tone];
  return (
    <span className="block space-y-1.5">
      <span className="block tabular-nums">
        of {bytes(ceiling)} ceiling
        {canEdit ? (
          <>
            {" · "}
            <Link to={r.connectSetup(slug)} className={LINK}>
              Change
            </Link>
          </>
        ) : null}
      </span>
      {words ? (
        <span
          className={cn(
            "block",
            status.tone === "danger" ? "text-danger" : "text-warning",
          )}
        >
          {words}
        </span>
      ) : null}
      <span
        role="meter"
        aria-label="Relay data this month"
        aria-valuemin={0}
        aria-valuemax={ceiling}
        aria-valuenow={Math.min(used, ceiling)}
        aria-valuetext={`${bytes(used)} of ${bytes(ceiling)}`}
        className="block"
      >
        <MeterBar ratio={ceiling > 0 ? used / ceiling : 1} tone={status.tone} />
      </span>
    </span>
  );
}

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
            <PeopleTile slug={slug} people={data.people} />
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
              Number.isFinite(ceiling) ? (
                <CeilingNote slug={slug} used={monthBytes} ceiling={ceiling} />
              ) : (
                "UTC month"
              )
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
          <PeopleTile slug={slug} people={data.people} />
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
