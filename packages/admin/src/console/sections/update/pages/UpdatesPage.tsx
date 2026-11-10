/**
 * Update → Updates (P2-11): the updaters for the platforms the product ships, each with its
 * Verified state. One card per shipped platform; the updaters it can use sit in a segmented
 * choice, the first being the usual one. A platform nothing ships on has no card.
 *
 * Verified is the Ship builds fact from the update-health counters (updaters send no
 * `X-PKey-SDK`, so no sighting exists): a device reported an update outcome on an outlet the
 * platform's updaters use. A failing card stays until a later outcome is clean; it is never a toast.
 */

import * as React from "react";
import { BookOpen } from "lucide-react";
import type { UpdaterId, UpdaterPlatform } from "../../../../api.js";
import { docsUrl } from "../../../../lib/docsLinks.js";
import { formatCount } from "../../../../lib/format.js";
import { Callout } from "../../../../ui/Callout.js";
import { CodeBlock } from "../../../../ui/CodeBlock.js";
import { CopyButton } from "../../../../ui/CopyButton.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { useLoadingAnnouncement } from "../../../../ui/loading.js";
import { PageHeader } from "../../../../ui/PageHeader.js";
import { Section } from "../../../../ui/Section.js";
import { SegmentedControl } from "../../../../ui/SegmentedControl.js";
import { Select } from "../../../../ui/Select.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { Link } from "../../../router.js";
import { r } from "../../../routes.js";
import { useUpdaters } from "../../distribution/data.js";
import { publicUrl } from "../../distribution/model/format.js";
import { useReleaseStore } from "../../release/data.js";
import {
  PLATFORM_LABEL,
  renderUpdaterSetup,
  UPDATER_LABEL,
} from "../model/updaterSetup.js";

const platformName = (p: string) => PLATFORM_LABEL[p] ?? p;

/** "Verified on 1 of 2", or null while it says nothing a card does not. */
export function partialLine(
  platforms: readonly UpdaterPlatform[],
): string | null {
  if (platforms.length < 2) return null;
  const known = platforms.filter((p) => p.state !== "unavailable");
  if (known.length === 0) return null;
  const ok = known.filter((p) => p.state === "verified").length;
  return ok === known.length ? null : `Verified on ${ok} of ${known.length}`;
}

export function UpdatesPage({ slug }: { slug: string }): React.ReactElement {
  const updaters = useUpdaters(slug);
  const store = useReleaseStore(slug);
  useLoadingAnnouncement("updaters", updaters.isPending);
  const channels = React.useMemo(() => {
    const set = new Set<string>(["stable"]);
    for (const c of store.data?.channels ?? []) set.add(c.channel);
    return [...set].sort((a, b) =>
      a === "stable" ? -1 : b === "stable" ? 1 : a.localeCompare(b),
    );
  }, [store.data]);
  const [channel, setChannel] = React.useState("stable");
  const current = channels.includes(channel) ? channel : "stable";
  const platforms = updaters.data?.platforms ?? [];
  const names = platforms.map((p) => platformName(p.platform)).join(", ");
  const partial = partialLine(platforms);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Updates"
        description={
          updaters.data && platforms.length > 0
            ? [`Updaters for ${names}.`, partial].filter(Boolean).join(" ")
            : undefined
        }
        refetching={updaters.isFetching && !updaters.isPending}
      />
      {updaters.isPending ? (
        <div
          className="space-y-3"
          aria-busy="true"
          aria-label="Loading the updaters"
        >
          <Skeleton className="h-56 w-full" />
          <Skeleton className="h-56 w-full" />
        </div>
      ) : updaters.isError || !updaters.data ? (
        <ErrorState
          error={updaters.error}
          onRetry={() => void updaters.refetch()}
          context={{ thing: "Updaters" }}
        />
      ) : platforms.length === 0 ? (
        <EmptyState
          kind="first-run"
          title="No platform shipped yet"
          description="An updater appears for each platform once a release has a build for it."
          docs={docsUrl("updates")}
          headingLevel={2}
        />
      ) : (
        <>
          {channels.length > 1 ? (
            <div className="flex flex-wrap items-center gap-2">
              <label
                htmlFor="updates-track"
                className="text-sm font-medium text-fg-muted"
              >
                Release track
              </label>
              <Select
                id="updates-track"
                value={current}
                onChange={(v) => v && setChannel(v)}
                options={channels.map((c) => ({ value: c, label: c }))}
                className="w-48"
              />
            </div>
          ) : null}
          {platforms.map((p) => (
            <PlatformCard
              key={p.platform}
              slug={slug}
              platform={p}
              channel={current}
            />
          ))}
        </>
      )}
    </div>
  );
}

function StatePill({ p }: { p: UpdaterPlatform }): React.ReactElement {
  switch (p.state) {
    case "verified":
      return <StatusPill tone="success">Verified</StatusPill>;
    case "failing":
      return <StatusPill tone="danger">Updates reverted</StatusPill>;
    case "unavailable":
      return <StatusPill tone="neutral">No data</StatusPill>;
    default:
      return <StatusPill tone="neutral">Not seen yet</StatusPill>;
  }
}

function footOf(p: UpdaterPlatform): string {
  const devices = (n: number) =>
    `${formatCount(n)} ${n === 1 ? "device" : "devices"}`;
  switch (p.state) {
    case "verified":
      return `${devices(p.checks)} reported an update.`;
    case "failing":
      return `${devices(p.failures)} reverted an update or rolled a boot back.`;
    case "unavailable":
      return "The update counters could not be read.";
    default:
      return `No ${platformName(p.platform)} device has reported an update.`;
  }
}

function PlatformCard({
  slug,
  platform: p,
  channel,
}: {
  slug: string;
  platform: UpdaterPlatform;
  channel: string;
}): React.ReactElement {
  const [chosen, setChosen] = React.useState<UpdaterId>(p.updaters[0]!);
  const updater = p.updaters.includes(chosen) ? chosen : p.updaters[0]!;
  const setup = renderUpdaterSetup({
    updater,
    platform: p.platform,
    channel,
    url: (path) => publicUrl(slug, path),
  });
  const name = platformName(p.platform);
  // A URL the snippet already carries (with its own copy button) is not listed twice.
  const endpoints = setup.endpoints.filter(
    (e) => !setup.snippet?.code.includes(e.url),
  );
  return (
    <Section title={name} actions={<StatePill p={p} />}>
      <div className="space-y-4">
        {p.state === "failing" ? (
          <Callout
            tone="danger"
            title="Devices reverted an update"
            action={
              <Link
                to={r.health(slug)}
                className="py-1 text-accent-fg underline-offset-4 hover:underline"
              >
                Open update health
              </Link>
            }
          >
            The release they moved to did not hold. Halt its rollout, then ship
            a fixed release. This clears when later updates succeed.
          </Callout>
        ) : null}
        {p.updaters.length > 1 ? (
          <SegmentedControl
            aria-label={`Updater for ${name}`}
            wrap
            value={updater}
            onChange={(v) => setChosen(v)}
            options={p.updaters.map((u) => ({
              value: u,
              label: UPDATER_LABEL[u],
            }))}
          />
        ) : (
          <p className="text-sm font-medium">{UPDATER_LABEL[updater]}</p>
        )}
        <div className="grid gap-6 lg:grid-cols-2">
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            {setup.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          {setup.snippet ? (
            <CodeBlock
              code={setup.snippet.code}
              language={setup.snippet.language}
              filename={setup.snippet.filename}
              wrap
            />
          ) : null}
        </div>
        {endpoints.length > 0 ? (
          <ul className="space-y-2" aria-label={`${name} feed URLs`}>
            {endpoints.map((e) => (
              <li
                key={e.url}
                className="flex flex-wrap items-center gap-2 sm:flex-nowrap"
              >
                <span className="w-full shrink-0 text-xs font-medium text-fg-muted sm:w-36">
                  {e.label}
                </span>
                <code className="min-w-0 flex-1 break-all rounded-sm bg-surface-sunken px-2 py-1 font-mono text-xs">
                  {e.url}
                </code>
                <CopyButton value={e.url} label={`Copy the ${e.label} URL`} />
              </li>
            ))}
          </ul>
        ) : null}
        <p className="flex items-center gap-2 border-t border-border pt-3 text-sm text-fg-muted">
          <span>{footOf(p)}</span>
          <a
            className="ml-auto inline-flex items-center gap-1 py-1 text-accent-fg underline-offset-4 hover:underline"
            href={docsUrl("updates")}
            target="_blank"
            rel="noreferrer"
          >
            <BookOpen className="size-4" aria-hidden="true" />
            Docs
          </a>
        </p>
      </div>
    </Section>
  );
}
