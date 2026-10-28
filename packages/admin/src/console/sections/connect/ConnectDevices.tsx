/**
 * Cloud Connect → Linked devices (CC-16.3). The people who have linked a device, paged by subject
 * (50 a page, "Show more people"), each with their device roster: label, platform, keys since,
 * last seen and the roster's epoch. Read-only; a person opens their user record and a device its
 * record on Devices, where
 * Deauthorize lives.
 *
 * A person's label is not stored, so the subject stands in (mono, middle-truncated, the full
 * value in the title). Certificate expiry and last relay use are drawn only when some device on the
 * page has one: the Worker answers `null` until it stores them, and an always-empty column is
 * noise (D1).
 */

import * as React from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { type ConnectDevice, type ConnectPerson } from "../../../api.js";
import {
  formatCount,
  formatRelative,
  fromSeconds,
  truncateMiddle,
} from "../../../lib/format.js";
import { platformName } from "../../../lib/vocab/platforms.js";
import { cn } from "../../../lib/cn.js";
import { Button } from "../../../ui/Button.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { Skeleton } from "../../../ui/Skeleton.js";
import { Link } from "../../router.js";
import { r } from "../../routes.js";
import { Panel } from "../../templates/Dashboard.js";
import { LABEL } from "../sync/pages/usageParts.js";
import { ConnectHeader } from "./ConnectHeader.js";
import { connectPeopleQuery } from "./data.js";
import { DOCS_LINKS } from "../../../lib/docsLinks.js";

const th =
  "px-4 py-2 text-start text-xs font-semibold text-fg-strong max-sm:sr-only";
const td = `px-4 py-2 align-middle text-sm max-sm:flex max-sm:flex-wrap max-sm:gap-x-3 max-sm:py-1 ${LABEL}`;

const ago = (sec: number): string => formatRelative(fromSeconds(sec));

export function ConnectDevicesPage({
  slug,
}: {
  slug: string;
}): React.ReactElement {
  const list = useInfiniteQuery(connectPeopleQuery(slug));
  const people: ConnectPerson[] = (list.data?.pages ?? []).flatMap((p) =>
    p.enabled ? p.people : [],
  );
  let body: React.ReactNode;
  if (list.isPending) {
    body = (
      <div className="space-y-4" aria-busy="true">
        <p role="status" className="sr-only">
          Loading linked devices
        </p>
        <Skeleton className="h-40 w-full rounded-xl" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  } else if (list.isError && people.length === 0) {
    body = (
      <ErrorState
        error={list.error}
        onRetry={() => void list.refetch()}
        thing="Linked devices"
        context={{ read: true }}
      />
    );
  } else if (people.length === 0) {
    body = (
      <EmptyState
        kind="first-run"
        headingLevel={2}
        docs={DOCS_LINKS.connect}
        title="No linked devices yet"
        description="A person's devices appear here once they link their first."
      />
    );
  } else {
    const all = people.flatMap((p) => p.devices);
    const cert = all.some((d) => d.certExpiresAt !== null);
    const relay = all.some((d) => d.lastRelayAt !== null);
    body = (
      <>
        <p className="text-sm text-fg-muted">
          {formatCount(people.length)}{" "}
          {people.length === 1 ? "person" : "people"}
          {list.hasNextPage ? " so far" : ""}.
        </p>
        <div className="space-y-4">
          {people.map((p) => (
            <PersonCard
              key={p.subject}
              slug={slug}
              person={p}
              cert={cert}
              relay={relay}
            />
          ))}
        </div>
        {list.isError ? (
          <ErrorState
            compact
            error={list.error}
            onRetry={() => void list.fetchNextPage()}
            thing="More people"
            context={{ read: true }}
          />
        ) : null}
        {list.hasNextPage ? (
          <div>
            <Button
              variant="outline"
              loading={list.isFetchingNextPage}
              onClick={() => void list.fetchNextPage()}
            >
              Show more people
            </Button>
          </div>
        ) : null}
      </>
    );
  }
  return (
    <div className="space-y-6" data-template="record">
      <ConnectHeader
        slug={slug}
        tab="connect-devices"
        refetching={
          list.isFetching && !list.isPending && !list.isFetchingNextPage
        }
      />
      {body}
    </div>
  );
}

function PersonCard({
  slug,
  person,
  cert,
  relay,
}: {
  slug: string;
  person: ConnectPerson;
  cert: boolean;
  relay: boolean;
}): React.ReactElement {
  const n = person.devices.length;
  return (
    <Panel
      title={
        <Link
          to={r.user(slug, person.subject)}
          className="underline-offset-2 hover:underline"
          title={person.subject}
        >
          {person.label ?? (
            <code className="font-mono text-sm font-medium">
              {truncateMiddle(person.subject, 10, 6)}
            </code>
          )}
        </Link>
      }
      description={`${formatCount(n)} ${n === 1 ? "device" : "devices"} · roster epoch ${formatCount(person.ringEpoch)}`}
    >
      <div className="pk-scroll -m-5 overflow-x-auto">
        <table className="w-full border-collapse max-sm:block">
          <caption className="sr-only">
            Devices of {person.label ?? person.subject}
          </caption>
          <thead className="max-sm:contents">
            <tr className="border-b border-border max-sm:sr-only">
              <th scope="col" className={th}>
                Device
              </th>
              <th scope="col" className={th}>
                Platform
              </th>
              <th scope="col" className={th}>
                Keys since
              </th>
              {cert ? (
                <th scope="col" className={th}>
                  Certificate expires
                </th>
              ) : null}
              {relay ? (
                <th scope="col" className={th}>
                  Last relay
                </th>
              ) : null}
              <th scope="col" className={th}>
                Last seen
              </th>
            </tr>
          </thead>
          <tbody className="max-sm:block">
            {person.devices.map((d) => (
              <DeviceRow
                key={d.deviceId}
                slug={slug}
                d={d}
                cert={cert}
                relay={relay}
              />
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function DeviceRow({
  slug,
  d,
  cert,
  relay,
}: {
  slug: string;
  d: ConnectDevice;
  cert: boolean;
  relay: boolean;
}): React.ReactElement {
  const muted = "text-fg-muted max-sm:ms-auto";
  return (
    <tr className="border-b border-border last:border-b-0 max-sm:block max-sm:py-2">
      <th
        scope="row"
        className="px-4 py-2 text-start align-middle text-sm font-normal max-sm:block max-sm:py-1"
      >
        <Link
          to={r.device(slug, d.deviceId)}
          className={cn(
            "font-medium text-accent-fg underline underline-offset-2 [overflow-wrap:anywhere]",
            !d.label && "font-mono text-xs",
          )}
          title={d.deviceId}
        >
          {d.label ?? truncateMiddle(d.deviceId, 8, 4)}
        </Link>
      </th>
      <td data-label="Platform" className={td}>
        <span className="max-sm:ms-auto">
          {d.platform ? platformName(d.platform) : "Not reported"}
        </span>
      </td>
      <td data-label="Keys since" className={td}>
        <span className={muted}>{ago(d.keysSince)}</span>
      </td>
      {cert ? (
        <td data-label="Certificate expires" className={td}>
          <span className={muted}>
            {d.certExpiresAt === null ? "None" : ago(d.certExpiresAt)}
          </span>
        </td>
      ) : null}
      {relay ? (
        <td data-label="Last relay" className={td}>
          <span className={muted}>
            {d.lastRelayAt === null ? "Never" : ago(d.lastRelayAt)}
          </span>
        </td>
      ) : null}
      <td data-label="Last seen" className={td}>
        <span className={muted}>{ago(d.lastSeen)}</span>
      </td>
    </tr>
  );
}
