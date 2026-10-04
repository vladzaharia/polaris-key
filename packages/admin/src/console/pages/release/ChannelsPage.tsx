import * as React from "react";
import type { ChannelPolicyDto } from "../../../api.js";
import { useLoadingAnnouncement } from "../../../ui/loading.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { PageSkeleton } from "../../../ui/Skeleton.js";
import { Select } from "../../../ui/Select.js";
import { SegmentedControl } from "../../../ui/SegmentedControl.js";
import { useProduct } from "../../data/hooks.js";
import { codecs, useSearchParam } from "../../router.js";
import { PageHeader } from "../../components/PageHeader.js";
import {
  usePackReleases,
  useReleaseChannels,
  useReleaseStore,
} from "./data.js";
import {
  ChannelLane,
  HowChannelsResolve,
  StrandedFloors,
  type LaneContext,
} from "./ChannelLanes.js";
import { PolicyDialog, type PolicyAction } from "./PolicyDialog.js";
import { APP, optionOfPackRelease, optionOfRelease } from "./shared.js";

/**
 * The lanes of one deliverable, with their dialog: the Channels page and a pack record's Channels
 * tab both render this (ADMIN.md §6.3.3, §6.3.4).
 */
export function DeliverableLanes({
  slug,
  deliverable,
  channels,
  platforms,
}: {
  slug: string;
  deliverable: string;
  channels: ChannelPolicyDto[];
  platforms: string[];
}): React.ReactElement {
  const isApp = deliverable === APP;
  const store = useReleaseStore(slug);
  const packs = usePackReleases(slug, isApp ? null : deliverable);
  const product = useProduct(slug);
  const [action, setAction] = React.useState<PolicyAction | null>(null);

  const releases = React.useMemo(
    () =>
      isApp
        ? (store.data?.releases ?? [])
            .filter((x) => x.deliverable === APP)
            .map(optionOfRelease)
        : (packs.data?.releases ?? []).map(optionOfPackRelease),
    [isApp, store.data, packs.data],
  );
  const floors = isApp ? (store.data?.floors ?? []) : [];
  // Only once the channels have loaded: before that every floor would look stranded.
  const stranded = floors.filter(
    (f) => !channels.some((c) => c.channel === f.channel),
  );
  const ctx: LaneContext = {
    slug,
    releases,
    platforms,
    floors,
    onAction: setAction,
    distributionOn: product.data?.services?.distribution?.enabled !== false,
  };

  return (
    <div className="space-y-4">
      {channels.length === 0 ? (
        <EmptyState
          kind="first-run"
          title="No channels yet"
          description={
            isApp
              ? "Channels appear once the product has a release configuration and a release in the store."
              : `Channels appear once ${deliverable} has a release on one.`
          }
        />
      ) : (
        channels.map((c) => (
          <ChannelLane key={c.channel} channel={c} ctx={ctx} />
        ))
      )}
      {isApp ? <StrandedFloors floors={stranded} onAction={setAction} /> : null}
      <PolicyDialog
        slug={slug}
        action={action}
        channels={channels}
        releases={releases}
        onClose={() => setAction(null)}
      />
    </div>
  );
}

/** Release → Channels (T5 lanes; ADMIN.md §6.3.3). `?deliverable=` picks app or a pack. */
export function ChannelsPage({ slug }: { slug: string }): React.ReactElement {
  const query = useReleaseChannels(slug);
  const [deliverable, setDeliverable] = useSearchParam(
    "deliverable",
    codecs.string(APP),
  );
  useLoadingAnnouncement("channels", query.isPending);
  const list = query.data?.deliverables ?? [];
  const current =
    list.find((d) => d.deliverable === deliverable) ??
    list.find((d) => d.deliverable === APP) ??
    list[0];
  const options = list.map((d) => ({
    value: d.deliverable,
    label: d.kind === "app" ? "App" : d.deliverable,
  }));

  const header = (
    <PageHeader
      title="Channels"
      description="What each channel serves on every platform, and the policy behind it. Changes made here survive a resync until you revert them."
      meta={<HowChannelsResolve />}
      refetching={query.isFetching && !query.isPending}
    />
  );

  if (query.isPending)
    return (
      <div className="space-y-6">
        {header}
        <PageSkeleton template="record" label="channels" />
      </div>
    );
  if (query.error && !query.data)
    return (
      <div className="space-y-6">
        {header}
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </div>
    );

  return (
    <div className="space-y-6" data-template="matrix">
      {header}
      {list.length > 1 ? (
        <div className="flex flex-wrap items-center gap-3">
          <span id="channels-deliverable" className="text-sm text-fg-muted">
            Deliverable
          </span>
          {list.length <= 4 ? (
            <SegmentedControl
              aria-labelledby="channels-deliverable"
              options={options}
              value={current?.deliverable ?? APP}
              onChange={(v) => setDeliverable(v)}
            />
          ) : (
            <Select
              aria-labelledby="channels-deliverable"
              options={options}
              value={current?.deliverable ?? APP}
              onChange={(v) => setDeliverable(v ?? APP)}
            />
          )}
        </div>
      ) : null}
      {current ? (
        <DeliverableLanes
          slug={slug}
          deliverable={current.deliverable}
          channels={current.channels}
          platforms={current.platforms}
        />
      ) : (
        <EmptyState
          kind="first-run"
          title="No channels yet"
          description="Channels appear once the product has a release configuration and a release in the store."
        />
      )}
    </div>
  );
}
