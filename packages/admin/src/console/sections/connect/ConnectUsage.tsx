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
import { formatCount } from "../../../lib/format.js";
import { DOCS_LINKS } from "../../../lib/docsLinks.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { StatTile } from "../../../ui/charts/StatTile.js";
import { Link } from "../../router.js";
import { r } from "../../routes.js";
import { Panel } from "../../templates/Dashboard.js";
import { formatBinaryBytes } from "../sync/pages/SyncData.js";
import { TILES, UsageSkeleton } from "../sync/pages/usageParts.js";
import { ConnectHeader } from "./ConnectHeader.js";
import { USAGE_DAYS, connectUsageQuery } from "./data.js";

const NBSP = "\u00a0";
const bytes = (n: number): string =>
  formatBinaryBytes(Math.max(0, n)).replace(" ", NBSP);

export function ConnectUsagePage({
  slug,
}: {
  slug: string;
}): React.ReactElement {
  const usage = useQuery(connectUsageQuery(slug));
  const data = usage.data?.enabled ? usage.data : null;
  let body: React.ReactNode;
  if (usage.isPending) {
    body = <UsageSkeleton tiles={3} />;
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
            <StatTile label="People" value={formatCount(data.people)} />
          </div>
        ) : null}
        <EmptyState
          kind="first-run"
          headingLevel={2}
          docs={DOCS_LINKS.connect}
          title="No relay traffic yet"
          description="Devices on the same network connect directly. The relay carries the rest."
          primaryAction={
            <Link
              to={r.connectSetup(slug)}
              className="py-1 text-accent-fg underline underline-offset-2"
            >
              See Setup
            </Link>
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
          <StatTile label="People" value={formatCount(data.people)} />
        </div>
        <Panel title="Per day" description="UTC, newest first">
          <div className="pk-scroll -m-5 max-h-[32rem] overflow-auto">
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
                    Data
                  </th>
                  <th
                    scope="col"
                    className="px-4 py-2 text-end text-xs font-semibold text-fg-strong"
                  >
                    Sessions
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
                    className="border-b border-border last:border-b-0"
                  >
                    <th
                      scope="row"
                      className="px-4 py-2 text-start font-normal tabular-nums"
                    >
                      {d.day}
                    </th>
                    <td className="px-4 py-2 text-end tabular-nums whitespace-nowrap">
                      {bytes(d.bytes)}
                    </td>
                    <td className="px-4 py-2 text-end tabular-nums">
                      {formatCount(d.sessions)}
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
          </div>
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
