/**
 * Update → Updates (P2-11): the updaters for the platforms the product ships, grouped by what
 * verifies together. An update-health event names an outlet but no platform, so Verified and the
 * failing state belong to a group (Polaris Locker, Google Play), never to one platform of it.
 * Platforms a store updates are listed once, without a self-updater.
 *
 * Verified is the Ship builds fact from the update-health counters (updaters send no
 * `X-PKey-SDK`, so no sighting exists). The "Set up with" choice is a view, nothing is saved.
 */

import * as React from "react";
import { Tabs } from "radix-ui";
import { CloudOff } from "lucide-react";
import { channelLabel } from "@polaris-key/manifest";
import type { UpdaterGroup, UpdaterId, UpdatersView } from "../../../../api.js";
import { cn } from "../../../../lib/cn.js";
import { platformName } from "../../../../lib/vocab/platforms.js";
import { docsUrl } from "../../../../lib/docsLinks.js";
import { formatCount } from "../../../../lib/format.js";
import { inlineCode } from "../../../../lib/inline.js";
import { ACCESS_LABELS, outletKindName } from "../../../../lib/labels.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { CodeBlock } from "../../../../ui/CodeBlock.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { useLoadingAnnouncement } from "../../../../ui/loading.js";
import { PageHeader } from "../../../../ui/PageHeader.js";
import { Section } from "../../../../ui/Section.js";
import { Select } from "../../../../ui/Select.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { Link, useSearchParam } from "../../../router.js";
import { codecs, r } from "../../../routes.js";
import { useUpdaters } from "../../distribution/data.js";
import { publicUrl } from "../../distribution/model/format.js";
import { useReleaseStore } from "../../release/data.js";
import { channelNames } from "./feedEndpoints.js";
import { renderUpdaterSetup, UPDATER_LABEL } from "../model/updaterSetup.js";

const TRACK = codecs.string("stable");
const LINK =
  "py-1 text-fg-strong underline underline-offset-4 hover:no-underline";

export function UpdatesPage({ slug }: { slug: string }): React.ReactElement {
  const updaters = useUpdaters(slug);
  const store = useReleaseStore(slug);
  useLoadingAnnouncement("updaters", updaters.isPending);
  const channels = React.useMemo(() => channelNames(store.data), [store.data]);
  const [track, setTrack] = useSearchParam("track", TRACK);
  const current = channels.includes(track) ? track : "stable";
  const view = updaters.data;
  const headingRef = React.useRef<HTMLDivElement>(null);
  const retry = async () => {
    await updaters.refetch();
    headingRef.current?.querySelector("h1")?.focus();
  };

  return (
    <div className="space-y-6" ref={headingRef}>
      <PageHeader
        title="Updates"
        refetching={updaters.isFetching && !updaters.isPending}
        primaryAction={
          <Button variant="outline" asChild>
            <a href={docsUrl("updates")} target="_blank" rel="noopener">
              Guide
            </a>
          </Button>
        }
      />
      {updaters.isPending ? (
        <LoadingCards />
      ) : updaters.isError || !view ? (
        <ErrorState
          error={updaters.error}
          onRetry={() => void retry()}
          context={{ thing: "Updaters" }}
        />
      ) : view.groups.length === 0 && view.store.length === 0 ? (
        <EmptyState
          kind="first-run"
          title="No platform shipped yet"
          description="An updater appears here once a release has a build for a platform."
          primaryAction={
            <Button variant="outline" asChild>
              <Link to={r.releases(slug)}>Open Releases</Link>
            </Button>
          }
          docs={docsUrl("updates")}
          headingLevel={2}
        />
      ) : (
        <Loaded
          slug={slug}
          view={view}
          channels={channels}
          track={current}
          onTrack={setTrack}
          onRetry={() => void retry()}
        />
      )}
    </div>
  );
}

function Loaded({
  slug,
  view,
  channels,
  track,
  onTrack,
  onRetry,
}: {
  slug: string;
  view: UpdatersView;
  channels: string[];
  track: string;
  onTrack: (t: string) => void;
  onRetry: () => void;
}): React.ReactElement {
  const noData = view.groups.some((g) => g.state === "unavailable");
  return (
    <>
      {noData ? (
        <Callout
          tone="warning"
          title="Update reports could not be read"
          action={
            <Button variant="outline" onClick={onRetry}>
              Try again
            </Button>
          }
        >
          Verified shows again once they can.
        </Callout>
      ) : null}
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
            value={track}
            onChange={(v) => v && onTrack(v)}
            options={channels.map((c) => ({ value: c, label: c }))}
            className="w-auto min-w-48"
          />
        </div>
      ) : null}
      {view.groups.map((g) => (
        <GroupCard key={g.id} slug={slug} group={g} track={track} view={view} />
      ))}
      {view.store.length > 0 ? (
        <Section title="Updated by the store">
          <ul className="space-y-1 text-sm">
            {view.store.map((p) => (
              <li key={p}>
                {platformName(p)}: the store offers the update; nothing to set
                up.
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      <RulesBand slug={slug} access={view.access} />
    </>
  );
}

function LoadingCards(): React.ReactElement {
  return (
    <div
      className="space-y-3"
      role="status"
      aria-busy="true"
      aria-label="Loading the updaters"
    >
      {[0, 1].map((i) => (
        <div key={i} className="rounded-xl border border-border">
          <Skeleton className="h-14 w-full rounded-none" />
          <div className="grid gap-4 p-4 lg:grid-cols-2">
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

const GROUP_TITLE: Record<UpdaterGroup["id"], string> = {
  direct: outletKindName("direct"),
  play: channelLabel("google-play"),
};

function StatePill({ g }: { g: UpdaterGroup }): React.ReactElement {
  switch (g.state) {
    case "verified":
      return <StatusPill tone="success">Verified</StatusPill>;
    case "failing":
      return (
        <StatusPill tone="danger">
          {formatCount(g.reverted)} reverted
        </StatusPill>
      );
    case "unavailable":
      return (
        <StatusPill tone="neutral" icon={CloudOff}>
          No data
        </StatusPill>
      );
    default:
      return (
        <StatusPill tone="neutral" className="border-dashed">
          Not seen yet
        </StatusPill>
      );
  }
}

function GroupCard({
  slug,
  group: g,
  track,
  view,
}: {
  slug: string;
  group: UpdaterGroup;
  track: string;
  view: UpdatersView;
}): React.ReactElement {
  const names = g.platforms.map((p) => platformName(p.platform)).join(", ");
  const title = `${GROUP_TITLE[g.id]}: ${names}`;
  return (
    <Section title={title} actions={<StatePill g={g} />}>
      <div className="space-y-5">
        {g.state === "failing" ? (
          <Callout
            tone="danger"
            title={
              g.release
                ? `${g.release} did not hold`
                : "Devices reverted an update"
            }
            action={
              <Link to={r.rollouts(slug)} className={LINK}>
                Open Rollouts
              </Link>
            }
          >
            Reverts and rollbacks after a failed start count while they are
            under 30 days old, on the newest six releases. Halt the rollout and
            ship a fixed release.{" "}
            <Link to={r.health(slug)} className={LINK}>
              Update health
            </Link>
          </Callout>
        ) : null}
        {g.state === "verified" ? (
          <p className="text-sm text-fg-muted">
            {formatCount(g.reports)} update{" "}
            {g.reports === 1 ? "report" : "reports"}.
          </p>
        ) : null}
        {g.platforms.map((p, i) => (
          <PlatformSetup
            key={p.platform}
            slug={slug}
            platform={p.platform}
            updaters={p.updaters}
            track={track}
            access={view.access}
            keyShared={i > 0}
            godot={view.groups.some((x) =>
              x.platforms.some((q) => q.updaters.includes("godot")),
            )}
            heading={g.platforms.length > 1}
          />
        ))}
      </div>
    </Section>
  );
}

function PlatformSetup({
  slug,
  platform,
  updaters,
  track,
  access,
  keyShared,
  godot,
  heading,
}: {
  slug: string;
  platform: string;
  updaters: UpdaterId[];
  track: string;
  access: string | null;
  keyShared: boolean;
  godot: boolean;
  heading: boolean;
}): React.ReactElement {
  const [chosen, setChosen] = React.useState<UpdaterId>(updaters[0]!);
  const name = platformName(platform);
  const options = updaters.map((u) => ({ value: u, label: UPDATER_LABEL[u] }));
  return (
    <Tabs.Root
      value={chosen}
      onValueChange={(v) => setChosen(v as UpdaterId)}
      className="space-y-3"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {heading ? <h3 className="text-sm font-semibold">{name}</h3> : null}
        {options.length > 1 ? (
          <>
            <Tabs.List
              aria-label={`Set up ${name} with`}
              className="hidden gap-4 border-b border-border sm:flex"
            >
              <span className="self-center pb-2 text-sm text-fg-muted">
                Set up with
              </span>
              {options.map((o) => (
                <Tabs.Trigger
                  key={o.value}
                  value={o.value}
                  className={cn(
                    "-mb-px border-b-[3px] border-transparent pb-2 pt-1 text-sm text-fg-muted",
                    "data-[state=active]:border-accent data-[state=active]:font-medium data-[state=active]:text-fg-strong",
                    "focus-visible:outline-2 focus-visible:outline-accent-fg",
                  )}
                >
                  {o.label}
                </Tabs.Trigger>
              ))}
            </Tabs.List>
            <div className="w-full sm:hidden">
              <Select
                aria-label={`Set up ${name} with`}
                value={chosen}
                onChange={(v) => v && setChosen(v as UpdaterId)}
                options={options}
              />
            </div>
          </>
        ) : null}
      </div>
      {options.map((o) => (
        <Tabs.Content key={o.value} value={o.value} tabIndex={-1}>
          <Setup
            slug={slug}
            platform={platform}
            updater={o.value}
            track={track}
            access={access}
            keyShared={keyShared}
            godot={godot}
          />
        </Tabs.Content>
      ))}
    </Tabs.Root>
  );
}

function Setup({
  slug,
  platform,
  updater,
  track,
  access,
  keyShared,
  godot,
}: {
  slug: string;
  platform: string;
  updater: UpdaterId;
  track: string;
  access: string | null;
  keyShared: boolean;
  godot: boolean;
}): React.ReactElement {
  const setup = renderUpdaterSetup({
    updater,
    platform,
    channel: track,
    access,
    keyShared,
    godot,
    url: (path) => publicUrl(slug, path),
  });
  return (
    <div className="grid gap-6 [grid-template-columns:minmax(0,1fr)] lg:grid-cols-2">
      <ol className="list-decimal space-y-2 pl-5 text-sm [overflow-wrap:anywhere]">
        {setup.steps.map((s) => (
          <li key={s}>{inlineCode(s)}</li>
        ))}
        {setup.docs ? (
          <li className="list-none">
            <a
              className={LINK}
              href={setup.docs.href}
              target="_blank"
              rel="noreferrer"
            >
              {setup.docs.label}
            </a>
          </li>
        ) : null}
      </ol>
      {setup.snippets.length > 0 ? (
        <div className="min-w-0 space-y-3">
          {setup.snippets.map((s) => (
            <CodeBlock
              key={s.label}
              code={s.code}
              language={s.language}
              filename={s.label}
              wrap
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function RulesBand({
  slug,
  access,
}: {
  slug: string;
  access: string | null;
}): React.ReactElement {
  return (
    <Section title="Update rules">
      <ul className="space-y-2 text-sm">
        <li>
          Who can check for updates:{" "}
          {access ? (ACCESS_LABELS[access] ?? access) : "not set"}.{" "}
          <Link to={r.access(slug)} className={LINK}>
            Change on Access
          </Link>
        </li>
        <li>
          Compatibility window and artifact policy:{" "}
          <Link to={r.feed(slug)} className={LINK}>
            Feed
          </Link>
        </li>
        <li>
          Verified covers every release track.{" "}
          <Link to={r.channels(slug)} className={LINK}>
            Release tracks
          </Link>
        </li>
      </ul>
    </Section>
  );
}
