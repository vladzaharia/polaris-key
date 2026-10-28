/**
 * Distribution → Channels → one channel (A-22.1; `distribution/channels/<id>/<tab>`): the shell and
 * the tab strip. The tabs come from `channelTabs.ts`, and only built ones show. The read is the
 * product's channel read model; a channel it does not list is out of scope, and an id the
 * catalogue does not know is not found.
 */

import * as React from "react";
import { CHANNEL_IDS, channelLabel } from "@polaris-key/manifest";
import { Button } from "../../../../ui/Button.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { PageHeader } from "../../../../ui/PageHeader.js";
import { PageSkeleton } from "../../../../ui/Skeleton.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { Breadcrumbs } from "../../../components/Breadcrumbs.js";
import { PageTabs, TabPanel } from "../../../components/PageTabs.js";
import { useProduct } from "../../../data/hooks.js";
import { Link, navigate } from "../../../router.js";
import { r } from "../../../routes.js";
import { CHANNEL_TABS } from "../components/channelTabs.js";
import { useChannels } from "../data.js";
import { channelPill } from "../model/channelCopy.js";

const TAB_PREFIX = "channel";

export function ChannelPage({
  slug,
  id,
  tab,
}: {
  slug: string;
  id?: string;
  tab?: string;
}): React.ReactElement {
  const product = useProduct(slug);
  const name = product.data?.name ?? slug;
  const known = id !== undefined && CHANNEL_IDS.some((c) => c === id);
  const channels = useChannels(slug, known);
  const row = channels.data?.channels.find((c) => c.id === id);
  const current = CHANNEL_TABS.find((t) => t.value === tab) ?? CHANNEL_TABS[0]!;
  // A tab that is in the address but not built yet opens Status, and the address says so.
  const unbuilt = tab !== undefined && current.value !== tab;
  React.useEffect(() => {
    if (unbuilt && id) navigate(r.channel(slug, id), { replace: true });
  }, [unbuilt, slug, id]);

  const label = known ? channelLabel(id) : "Channel";
  const crumbs = (
    <Breadcrumbs
      items={[{ label: "Channel setup", to: r.outlets(slug) }, { label }]}
    />
  );
  const back = (
    <Button asChild variant="outline">
      <Link to={r.outlets(slug)}>Channel setup</Link>
    </Button>
  );

  if (!known)
    return (
      <div className="space-y-6" data-state="unknown">
        <PageHeader eyebrow={crumbs} title="Channel not found" />
        <EmptyState
          kind="not-found"
          title={id ? `There is no channel “${id}”` : "Pick a channel"}
          description="Channels are the stores and package managers Polaris Key ships to."
          primaryAction={back}
        />
      </div>
    );
  if (channels.isPending)
    return <PageSkeleton template="record" label="channel" />;
  if (channels.error && !channels.data)
    return (
      <div className="space-y-6">
        <PageHeader eyebrow={crumbs} title={label} />
        <ErrorState
          error={channels.error}
          onRetry={() => void channels.refetch()}
          thing="Channel"
        />
      </div>
    );
  if (!row)
    return (
      <div className="space-y-6" data-state="out-of-scope">
        <PageHeader
          eyebrow={crumbs}
          title={label}
          titleAside={
            <StatusPill tone="neutral" size="sm">
              Out of scope
            </StatusPill>
          }
        />
        <EmptyState
          kind="not-found"
          title={`${label} is out of scope for ${name}`}
          description={`None of ${name}'s platforms fit it.`}
          primaryAction={back}
        />
      </div>
    );

  const pill = channelPill(row.delivery.state, !row.inScope);
  const Panel = current.Panel;
  return (
    <div className="space-y-6" data-template="record">
      <PageHeader
        eyebrow={crumbs}
        title={row.label}
        titleAside={<StatusPill tone={pill.tone}>{pill.label}</StatusPill>}
        tabs={
          <PageTabs
            label={`${row.label} tabs`}
            idPrefix={TAB_PREFIX}
            value={current.value}
            items={CHANNEL_TABS.map((t) => ({
              value: t.value,
              label: t.label,
            }))}
            onChange={(v) =>
              navigate(
                r.channel(
                  slug,
                  row.id,
                  v === CHANNEL_TABS[0]!.value ? undefined : v,
                ),
              )
            }
          />
        }
      />
      <TabPanel
        value={current.value}
        current={current.value}
        idPrefix={TAB_PREFIX}
      >
        <Panel slug={slug} name={name} channel={row} />
      </TabPanel>
    </div>
  );
}
