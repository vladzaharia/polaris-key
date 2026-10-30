/**
 * Cloud Connect → Linked devices (CC-16.3). The people who have linked a device, paged by subject
 * (50 a page, "Load more"), each with their device roster: label, platform, linked and last
 * seen, newest first. Read-only; a person opens their user record and a device its record on
 * Devices, where Deauthorize lives.
 *
 * A person is labelled by their shared contact email when the product may see one (the Worker
 * decides; Users shows the same email); the subject then sits under it. Without one the subject
 * stands in, in full. The columns share one width plan, so they line up from card to card.
 *
 * `?subject=` (the Users record links here) narrows the page to that one person, an exact match.
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
import { DOCS_LINKS } from "../../../lib/docsLinks.js";
import { platformName } from "../../../lib/vocab/platforms.js";
import { cn } from "../../../lib/cn.js";
import { Button } from "../../../ui/Button.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { Skeleton } from "../../../ui/Skeleton.js";
import { Link, useSearchParam } from "../../router.js";
import { codecs, r } from "../../routes.js";
import { Panel } from "../../templates/Dashboard.js";
import { LABEL } from "../sync/pages/usageParts.js";
import { ConnectHeader } from "./ConnectHeader.js";
import { connectPeopleQuery } from "./data.js";

const subjectCodec = codecs.string("");

const th =
  "px-4 py-2 text-start text-xs font-semibold text-fg-strong max-sm:sr-only";
const thEnd = th.replace("text-start", "text-end");
const td = `px-4 py-2 align-middle text-sm max-sm:flex max-sm:flex-wrap max-sm:gap-x-3 max-sm:py-1 ${LABEL}`;
const tdEnd = `${td} text-end`;
const LINK =
  "inline-flex min-h-6 items-center text-accent-fg underline underline-offset-2 [overflow-wrap:anywhere]";

const ago = (sec: number): string => formatRelative(fromSeconds(sec));

/** Focus a person's link once it is drawn (the Load more button that had focus is gone or moved). */
function focusPerson(subject: string | undefined): void {
  if (!subject) return;
  requestAnimationFrame(() =>
    [...document.querySelectorAll<HTMLElement>("[data-person-link]")]
      .find((el) => el.dataset.personLink === subject)
      ?.focus(),
  );
}

function PeopleSkeleton(): React.ReactElement {
  return (
    <div className="space-y-4" aria-busy="true">
      <p role="status" className="sr-only">
        Loading linked devices
      </p>
      {["a", "b"].map((k) => (
        <div
          key={k}
          aria-hidden
          className="space-y-3 rounded-xl border border-border p-5"
        >
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
        </div>
      ))}
    </div>
  );
}

export function ConnectDevicesPage({
  slug,
}: {
  slug: string;
}): React.ReactElement {
  const [subject] = useSearchParam("subject", subjectCodec);
  const list = useInfiniteQuery(connectPeopleQuery(slug, subject || null));
  const people: ConnectPerson[] = (list.data?.pages ?? []).flatMap((p) =>
    p.enabled ? p.people : [],
  );
  // Focus has to land somewhere real when the control that held it goes away (a11y): the count
  // line after "Show everyone", Retry after a failed "Load more".
  const countRef = React.useRef<HTMLParagraphElement>(null);
  const errorRef = React.useRef<HTMLDivElement>(null);
  const wantCount = React.useRef(false);
  const wantRetry = React.useRef(false);
  const moreFailed = list.isError && people.length > 0;
  React.useEffect(() => {
    if (wantCount.current && !subject && !list.isPending) {
      wantCount.current = false;
      countRef.current?.focus();
    }
  }, [subject, list.isPending, people.length]);
  React.useEffect(() => {
    if (wantRetry.current && moreFailed) {
      wantRetry.current = false;
      errorRef.current?.querySelector<HTMLElement>("button")?.focus();
    }
  }, [moreFailed]);
  const more = async (): Promise<void> => {
    wantRetry.current = true;
    const seen = new Set(people.map((p) => p.subject));
    const res = await list.fetchNextPage();
    const next = (res.data?.pages ?? [])
      .flatMap((p) => (p.enabled ? p.people : []))
      .find((p) => !seen.has(p.subject));
    if (!res.isError) wantRetry.current = false;
    focusPerson(next?.subject);
  };
  const showEveryone = (
    <Link
      to={r.connectDevices(slug)}
      className={LINK}
      onClick={() => {
        wantCount.current = true;
      }}
    >
      Show everyone
    </Link>
  );
  let body: React.ReactNode;
  if (list.isPending) {
    body = <PeopleSkeleton />;
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
        title={
          subject ? "No linked devices for this user" : "No linked devices yet"
        }
        description={
          subject
            ? "This user has not linked a device from your app."
            : "A person appears here once they link a device from your app."
        }
        primaryAction={subject ? showEveryone : undefined}
      />
    );
  } else {
    body = (
      <>
        <p
          ref={countRef}
          tabIndex={-1}
          aria-live="polite"
          className="text-sm text-fg-muted"
        >
          Showing {formatCount(people.length)}{" "}
          {people.length === 1 ? "person" : "people"}
          {subject ? <> · {showEveryone}</> : null}
        </p>
        <div className="space-y-4">
          {people.map((p) => (
            <PersonCard key={p.subject} slug={slug} person={p} />
          ))}
        </div>
        {list.isError ? (
          <div ref={errorRef}>
            <ErrorState
              compact
              thing="More people"
              context={{ read: true }}
              error={list.error}
              onRetry={() => void more()}
            />
          </div>
        ) : list.hasNextPage ? (
          <div>
            <Button
              variant="outline"
              loading={list.isFetchingNextPage}
              onClick={() => void more()}
            >
              Load more
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
}: {
  slug: string;
  person: ConnectPerson;
}): React.ReactElement {
  const n = person.devices.length;
  // One width plan for every card: the device column, then the rest in equal shares.
  const rest = 3;
  const share = `${(70 / rest).toFixed(2)}%`;
  const name = person.label ?? person.subject;
  const devices = [...person.devices].sort((a, b) => b.lastSeen - a.lastSeen);
  return (
    <Panel
      title={
        <Link
          to={r.user(slug, person.subject)}
          data-person-link={person.subject}
          className={cn(
            LINK,
            "text-sm font-medium",
            person.label === null && "font-mono",
          )}
        >
          {name}
        </Link>
      }
      description={
        <>
          {person.label !== null ? (
            <>
              <span className="font-mono [overflow-wrap:anywhere]">
                {person.subject}
              </span>
              {" · "}
            </>
          ) : null}
          {`${formatCount(n)}\u00a0${n === 1 ? "device" : "devices"}`}
        </>
      }
    >
      <div className="pk-scroll -m-5 overflow-x-auto">
        <table className="w-full table-fixed border-collapse max-sm:block">
          <caption className="sr-only">Devices of {name}</caption>
          <colgroup className="max-sm:hidden">
            <col className="w-[30%]" />
            {Array.from({ length: rest }, (_, i) => (
              <col key={i} style={{ width: share }} />
            ))}
          </colgroup>
          <thead className="max-sm:contents">
            <tr className="border-b border-border max-sm:sr-only">
              <th scope="col" className={th}>
                Device
              </th>
              <th scope="col" className={th}>
                Platform
              </th>
              <th scope="col" className={thEnd}>
                Linked
              </th>
              <th scope="col" className={thEnd}>
                Last seen
              </th>
            </tr>
          </thead>
          <tbody className="max-sm:block">
            {devices.map((d) => (
              <DeviceRow key={d.deviceId} slug={slug} d={d} />
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
}: {
  slug: string;
  d: ConnectDevice;
}): React.ReactElement {
  const muted = "tabular-nums text-fg-muted max-sm:ms-auto";
  return (
    <tr className="border-b border-border last:border-b-0 max-sm:block max-sm:py-2">
      <th
        scope="row"
        className="px-4 py-2 text-start align-middle text-sm font-normal max-sm:block max-sm:py-1"
      >
        <Link
          to={r.device(slug, d.deviceId)}
          className={cn(LINK, "font-medium", !d.label && "font-mono text-xs")}
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
      <td data-label="Linked" className={tdEnd}>
        <span className={muted}>{ago(d.keysSince)}</span>
      </td>
      <td data-label="Last seen" className={tdEnd}>
        <span className={muted}>{ago(d.lastSeen)}</span>
      </td>
    </tr>
  );
}
