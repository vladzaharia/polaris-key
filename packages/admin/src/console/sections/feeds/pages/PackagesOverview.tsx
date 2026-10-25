/**
 * Packages, product scope (F-34.7, UX-33; mockups `packages.feeds` and `packages.feeds-empty`):
 * one card per provisioned feed, in tab order, each naming its packages and the version on each
 * release track; the access is a read-only chip beside the URL. Nothing here turns a feed on: a
 * feed exists because a package is declared in `.pkey/release`. The off switch is F-34.8's, the
 * cleanup notice F-36's; both sit between the header and the cards.
 */

import * as React from "react";
import { Clock, Globe, Lock } from "lucide-react";
import type {
  DeliverableDto,
  FeedPackageRow,
  FeedSummary,
  FeedsOverviewDto,
} from "../../../../api.js";
import { docsUrl } from "../../../../lib/docsLinks.js";
import { formatCount, fromSeconds } from "../../../../lib/format.js";
import { Button } from "../../../../ui/Button.js";
import { CopyButton } from "../../../../ui/CopyButton.js";
import { Section } from "../../../../ui/Section.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { Timestamp } from "../../../../ui/Timestamp.js";
import { useQuery } from "@tanstack/react-query";
import { deliverablesQuery } from "../../release/data.js";
import { Link } from "../../../router.js";
import { useFeedPackages } from "../data.js";
import {
  ECOSYSTEMS,
  ECOSYSTEM_ICONS,
  ECOSYSTEM_LABELS,
  OFF_REASONS,
  feedAccessText,
  feedHref,
  packageHref,
  type FeedScope,
} from "../model/model.js";
import { FeedStatusPill } from "./FeedsArea.js";
import { BUILD_DIR, CommandLine, publishCommand } from "./PackagesEmpty.js";

/** The feeds the product has (the ones a declared package provisioned), in tab order. */
export function provisionedFeeds(data: FeedsOverviewDto): FeedSummary[] {
  return ECOSYSTEMS.map((e) =>
    data.feeds.find((f) => f.ecosystem === e && f.configured),
  ).filter((f): f is FeedSummary => f !== undefined);
}

/** How often the overview is re-read while a feed waits for its first package. */
export const PACKAGES_POLL_MS = 10_000;

/** Is a feed waiting for its first package (and able to get one)? */
export function isWaiting(f: FeedSummary): boolean {
  return f.configured && f.status === "enabled" && f.packages === 0;
}

/** Re-read while nothing is declared or a feed waits for its first package. */
export function pollPackages(d: FeedsOverviewDto | undefined): number | false {
  if (!d) return false;
  const feeds = provisionedFeeds(d);
  return feeds.length === 0 || feeds.some(isWaiting) ? PACKAGES_POLL_MS : false;
}

/** Packages that show on a card before "(N more)". */
const CARD_ROWS = 5;

const TRACK_ORDER = ["stable", "beta", "dev"];

/** The release tracks the rows carry, stable first. */
function tracksOf(rows: FeedPackageRow[]): string[] {
  const seen = new Set(rows.flatMap((r) => r.tags.map((t) => t.channel)));
  return [...seen].sort((a, b) => {
    const ia = TRACK_ORDER.indexOf(a);
    const ib = TRACK_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
}

function Sep(): React.ReactElement {
  return (
    <span aria-hidden className="text-fg-subtle">
      ·{" "}
    </span>
  );
}

/** "Licensed" or "Public"; the link says where access changes. */
function AccessChip({
  scope,
  feed,
}: {
  scope: FeedScope;
  feed: FeedSummary;
}): React.ReactElement {
  const Icon = feed.accessMode === "public" ? Globe : Lock;
  const label = feedAccessText(feed.accessMode);
  return (
    <Link
      to={feedHref(scope, feed.ecosystem, "settings")}
      data-access-chip=""
      title="Change in Settings"
      aria-label={`Access: ${label}. Change in Settings`}
      className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-fg-muted hover:bg-hover hover:text-fg-strong"
    >
      <Icon aria-hidden className="size-3.5" />
      {label}
    </Link>
  );
}

/** The registry URL with copy, breaking only after a `/` or a `.`. */
function FeedUrl({
  url,
  label,
}: {
  url: string;
  label: string;
}): React.ReactElement {
  const parts = url
    .replace(/^https?:\/\//, "")
    .split(/(?<=[/.])/)
    .filter(Boolean);
  return (
    <span className="min-w-0 max-w-full text-xs">
      <span className="font-mono">
        {parts.map((p, i) => (
          <React.Fragment key={i}>
            {p}
            <wbr />
          </React.Fragment>
        ))}
      </span>{" "}
      <CopyButton
        value={url}
        label={`Copy the ${label} registry URL`}
        size="xs"
      />
    </span>
  );
}

function PackageRows({
  scope,
  feed,
}: {
  scope: FeedScope;
  feed: FeedSummary;
}): React.ReactElement {
  const query = useFeedPackages(scope, feed.ecosystem, "", "");
  const label = ECOSYSTEM_LABELS[feed.ecosystem];
  const rows = (query.data?.pages[0]?.items ?? []).slice(0, CARD_ROWS);
  const tracks = tracksOf(rows);
  const more = query.data ? feed.packages - rows.length : 0;
  return (
    <>
      {query.isPending ? (
        <div aria-hidden className="space-y-2">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-5 w-1/2" />
        </div>
      ) : null}
      {rows.length ? (
        <ul
          aria-label={`${label} packages`}
          className="m-0 list-none divide-y divide-border p-0"
        >
          {rows.map((r) => {
            const ownTracks = tracks.filter((t) =>
              r.tags.some((x) => x.channel === t),
            );
            return (
              <li
                key={`${r.owner}/${r.deliverableId}`}
                className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0"
              >
                <Link
                  to={packageHref(scope, feed.ecosystem, r.owner, r.name)}
                  className="font-mono text-sm text-fg-strong underline-offset-2 hover:underline"
                >
                  {r.name.split(/(?<=[/\-.])/).map((part, i) => (
                    <React.Fragment key={i}>
                      {part}
                      <wbr />
                    </React.Fragment>
                  ))}
                </Link>
                <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-fg-muted">
                  {ownTracks.map((t) => {
                    const tag = r.tags.find((x) => x.channel === t)!;
                    return (
                      <span
                        key={t}
                        className="font-mono [overflow-wrap:anywhere]"
                      >
                        {t} <span className="text-fg">{tag.version}</span>
                      </span>
                    );
                  })}
                  <span>
                    {ownTracks.length ? <Sep /> : null}
                    {formatCount(r.versions)}{" "}
                    {r.versions === 1 ? "version" : "versions"}
                  </span>
                  {r.lastPublishedAt ? (
                    <>
                      <span>
                        <Sep />
                        Last publish{" "}
                        <Timestamp at={fromSeconds(r.lastPublishedAt)} />
                      </span>
                    </>
                  ) : null}
                </p>
              </li>
            );
          })}
        </ul>
      ) : null}
      {query.isError ? (
        <p
          role="alert"
          className="m-0 flex flex-wrap items-center gap-2 text-sm text-danger"
        >
          The packages didn't load.
          <Button
            variant="ghost"
            size="xs"
            onClick={() => void query.refetch()}
          >
            Retry
          </Button>
        </p>
      ) : null}
      <Link
        to={feedHref(scope, feed.ecosystem)}
        className="mt-auto inline-block self-start pt-1 text-sm text-accent-fg underline-offset-2 hover:underline"
      >
        Open the {label} feed{more > 0 ? ` (${formatCount(more)} more)` : ""}
      </Link>
    </>
  );
}

/** The package deliverable of this feed's ecosystem, when the release read has it. */
function deliverableFor(
  rows: DeliverableDto[] | undefined,
  eco: string,
): string | null {
  return rows?.find((d) => d.kind === "package" && d.type === eco)?.id ?? null;
}

/** A declared, enabled feed with no package yet: the CI step that publishes it. */
function WaitingBody({
  deliverable,
}: {
  deliverable: string | null;
}): React.ReactElement {
  return (
    <div className="space-y-2 text-sm">
      <p className="flex items-center gap-2 text-fg-muted">
        <Clock aria-hidden className="size-4 shrink-0" />
        Waiting for the first package…
      </p>
      {deliverable ? (
        <CommandLine
          command={publishCommand(deliverable, BUILD_DIR)}
          className="rounded-lg border"
        />
      ) : (
        <p className="m-0 text-fg-muted">
          Publish this package from your CI.{" "}
          <a
            href={docsUrl("publishFromCi")}
            target="_blank"
            rel="noreferrer"
            className="text-accent-fg underline underline-offset-2"
          >
            How to set it up
          </a>
        </p>
      )}
    </div>
  );
}

function FeedCard({
  scope,
  feed,
  deliverable,
}: {
  scope: FeedScope;
  feed: FeedSummary;
  deliverable: string | null;
}): React.ReactElement {
  const Icon = ECOSYSTEM_ICONS[feed.ecosystem];
  const label = ECOSYSTEM_LABELS[feed.ecosystem];
  const off = feed.status !== "enabled";
  return (
    <Section
      title={
        <span className="inline-flex items-center gap-2">
          <Icon aria-hidden className="size-5 text-fg-muted" />
          {label}
        </span>
      }
      description={
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {feed.baseUrl ? <FeedUrl url={feed.baseUrl} label={label} /> : null}
          <AccessChip scope={scope} feed={feed} />
        </span>
      }
    >
      <div
        data-feed-card={feed.ecosystem}
        className="flex h-full flex-col gap-3"
      >
        {off ? (
          <div className="flex flex-1 flex-col gap-1 text-sm">
            <p className="flex flex-wrap items-center gap-2">
              <FeedStatusPill feed={feed} />
              <span>Installs and CI publishes are refused.</span>
            </p>
            {feed.reason && feed.reason !== "feed-off" ? (
              <p className="m-0 text-fg-muted">{OFF_REASONS[feed.reason]}</p>
            ) : null}
            {feed.reason === "feed-off" || feed.reason === null ? (
              <Link
                to={feedHref(scope, feed.ecosystem, "settings")}
                className="mt-auto inline-block self-start pt-1 text-accent-fg underline-offset-2 hover:underline"
              >
                Turn it on in Settings
              </Link>
            ) : feed.reason === "platform-off" ? (
              <Link
                to="#/platform/feeds"
                className="mt-auto inline-block self-start pt-1 text-accent-fg underline-offset-2 hover:underline"
              >
                Platform package feeds
              </Link>
            ) : null}
          </div>
        ) : null}
        {feed.packages === 0 ? (
          off ? null : (
            <WaitingBody deliverable={deliverable} />
          )
        ) : (
          <PackageRows scope={scope} feed={feed} />
        )}
      </div>
    </Section>
  );
}

/** One card per provisioned feed, two across from `lg`. */
export function FeedCards({
  scope,
  feeds,
  focusFirst = false,
}: {
  scope: FeedScope;
  feeds: FeedSummary[];
  /** Move focus to the first card's heading on mount (the first feed just arrived). */
  focusFirst?: boolean;
}): React.ReactElement {
  const listRef = React.useRef<HTMLUListElement>(null);
  React.useEffect(() => {
    if (!focusFirst) return;
    const h = listRef.current?.querySelector<HTMLElement>("h2");
    h?.setAttribute("tabindex", "-1");
    h?.focus();
  }, [focusFirst]);
  const needsDeliverable = scope.kind === "product" && feeds.some(isWaiting);
  const slug = scope.kind === "product" ? scope.slug : "";
  const deliverables = useQuery({
    ...deliverablesQuery(slug),
    enabled: needsDeliverable,
  });
  return (
    <ul
      ref={listRef}
      aria-label="Package feeds"
      className="m-0 grid list-none grid-cols-1 gap-4 p-0 lg:grid-cols-2 2xl:grid-cols-3"
    >
      {feeds.map((f) => (
        <li key={f.ecosystem} className="flex min-w-0 flex-col [&>*]:flex-1">
          <FeedCard
            scope={scope}
            feed={f}
            deliverable={deliverableFor(
              needsDeliverable ? deliverables.data?.deliverables : undefined,
              f.ecosystem,
            )}
          />
        </li>
      ))}
    </ul>
  );
}

/** The card-shaped loading state. */
export function CardsSkeleton(): React.ReactElement {
  return (
    <div
      data-skeleton="cards"
      className="pk-skeleton-group grid gap-4 lg:grid-cols-2"
    >
      {[0, 1].map((i) => (
        <div key={i} className="space-y-3 rounded-xl border border-border p-5">
          <Skeleton className="h-6 w-24" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ))}
    </div>
  );
}

/** Did the first feed just arrive on a page that showed the empty panel? Focus follows to it. */
export function useFirstFeedArrived(
  data: FeedsOverviewDto | undefined,
  product: boolean,
): boolean {
  const count = data && product ? provisionedFeeds(data).length : null;
  const prev = React.useRef<number | null>(null);
  const arrived = prev.current === 0 && (count ?? 0) > 0;
  React.useEffect(() => {
    prev.current = count;
  }, [count]);
  return arrived;
}
