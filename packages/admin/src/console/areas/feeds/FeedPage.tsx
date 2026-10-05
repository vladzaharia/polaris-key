/**
 * One feed's page (T3 with route tabs; notes/S-12 §10.1): Packages, Setup, Settings and Activity,
 * the same component in both scopes. The Owner column, the owner filter and the platform policy
 * appear only in platform scope.
 */

import * as React from "react";
import { RefreshCw } from "lucide-react";
import type {
  FeedDetailDto,
  FeedEcosystem,
  FeedPackageRow,
} from "../../../api.js";
import { docsUrl } from "../../../lib/docsLinks.js";
import { formatCount, fromSeconds } from "../../../lib/format.js";
import { Callout } from "../../../ui/Callout.js";
import { CodeBlock } from "../../../ui/CodeBlock.js";
import { CopyButton } from "../../../ui/CopyButton.js";
import { DataTable, type DataColumn } from "../../../ui/data-table/index.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { SegmentedControl } from "../../../ui/SegmentedControl.js";
import { PageSkeleton } from "../../../ui/Skeleton.js";
import { StatusPill } from "../../../ui/StatusPill.js";
import { Timeline, TimelineItem } from "../../../ui/Timeline.js";
import { Timestamp } from "../../../ui/Timestamp.js";
import { toast } from "../../../ui/toast.js";
import { useLoadingAnnouncement } from "../../../ui/loading.js";
import { errorCopy } from "../../../lib/errorCopy.js";
import { PageHeader } from "../../components/PageHeader.js";
import { PageTabs } from "../../components/PageTabs.js";
import { mutate } from "../../data/mutations.js";
import { Link } from "../../router.js";
import { FEED_TABS } from "../../nav.js";
import { verbFor } from "../../pages/core/activityVerbs.js";
import { useFeedActivity, useFeedDetail, useFeedPackages } from "./data.js";
import { FeedNav, FeedStatusPill } from "./FeedsArea.js";
import { FeedSettingsTab } from "./FeedSettings.js";
import {
  ECOSYSTEM_CLIENTS,
  ECOSYSTEM_ICONS,
  ECOSYSTEM_LABELS,
  OFF_REASONS,
  SYSTEM_PRODUCT_SLUG,
  feedHref,
  feedSetupSnippets,
  packageHref,
  TOKEN_ENV,
  type FeedScope,
  type FeedSnippet,
} from "./model.js";

const TAB_LABELS: Record<(typeof FEED_TABS)[number], string> = {
  packages: "Packages",
  setup: "Setup",
  settings: "Settings",
  activity: "Activity",
};

export function FeedPage({
  scope,
  eco,
  tab,
}: {
  scope: FeedScope;
  eco: FeedEcosystem;
  tab?: string;
}): React.ReactElement {
  const detail = useFeedDetail(scope, eco);
  useLoadingAnnouncement("feed", detail.isPending);
  const current = (FEED_TABS as readonly string[]).includes(tab ?? "")
    ? (tab as (typeof FEED_TABS)[number])
    : "packages";
  const Icon = ECOSYSTEM_ICONS[eco];
  const data = detail.data;

  const rebuild = async (): Promise<void> => {
    try {
      const res = await mutate("rebuildFeed", scope, eco);
      toast.success(
        res.queued === 0
          ? "Nothing to rebuild: the feed has no packages"
          : `Rebuild queued for ${formatCount(res.queued)} package${res.queued === 1 ? "" : "s"}`,
      );
    } catch (e) {
      toast.error(errorCopy(e).title);
    }
  };

  const header = (
    <PageHeader
      eyebrow={<FeedNav scope={scope} current={eco} />}
      title={
        <span className="inline-flex items-center gap-2">
          <Icon aria-hidden className="size-6 text-accent" />
          {ECOSYSTEM_LABELS[eco]}
        </span>
      }
      titleAside={data ? <FeedStatusPill feed={data.feed} /> : undefined}
      description={
        data?.feed.baseUrl ? (
          <span className="inline-flex flex-wrap items-center gap-1">
            <span className="font-mono text-xs">{data.feed.baseUrl}</span>
            <CopyButton
              value={data.feed.baseUrl}
              label="Copy the registry URL"
              size="xs"
            />
          </span>
        ) : (
          ECOSYSTEM_CLIENTS[eco]
        )
      }
      meta={
        data?.feed.baseUrl ? (
          <span className="text-xs text-fg-muted">
            {ECOSYSTEM_CLIENTS[eco]}
          </span>
        ) : undefined
      }
      secondaryActions={
        data?.owner
          ? [
              {
                label: "Rebuild feed",
                icon: <RefreshCw aria-hidden />,
                onSelect: () => void rebuild(),
              },
            ]
          : []
      }
      tabs={
        <PageTabs
          label={`${ECOSYSTEM_LABELS[eco]} feed`}
          value={current}
          items={FEED_TABS.map((t) => ({
            value: t,
            label: TAB_LABELS[t],
            to: feedHref(scope, eco, t),
            ...(t === "packages" && data ? { count: data.feed.packages } : {}),
          }))}
        />
      }
      refetching={detail.isFetching && !detail.isPending}
      sticky
    />
  );

  if (detail.isPending)
    return (
      <div className="space-y-6">
        {header}
        <PageSkeleton template="record" label="feed" />
      </div>
    );
  if (detail.isError || !data)
    return (
      <div className="space-y-6">
        {header}
        <ErrorState
          error={detail.error}
          onRetry={() => void detail.refetch()}
          context={{ area: "distribution", thing: "Feed" }}
        />
      </div>
    );

  return (
    <div className="space-y-6">
      {header}
      {data.feed.reason && data.feed.reason !== "not-set-up" ? (
        <Callout
          tone={data.feed.status === "unavailable" ? "warning" : "info"}
          title="Clients get not-found from this feed"
        >
          {OFF_REASONS[data.feed.reason]}
        </Callout>
      ) : null}
      {current === "packages" ? (
        <PackagesTab scope={scope} eco={eco} detail={data} />
      ) : current === "setup" ? (
        <SetupTab eco={eco} detail={data} />
      ) : current === "settings" ? (
        <FeedSettingsTab scope={scope} eco={eco} detail={data} />
      ) : (
        <ActivityTab scope={scope} eco={eco} />
      )}
    </div>
  );
}

function packageColumns(
  scope: FeedScope,
  capabilities: FeedDetailDto["capabilities"],
): DataColumn<FeedPackageRow>[] {
  const cols: DataColumn<FeedPackageRow>[] = [
    {
      id: "name",
      header: "Name",
      accessorFn: (p) => p.name,
      meta: { priority: 1, primary: true, mono: true, label: "Name" },
    },
  ];
  if (scope.kind === "platform")
    cols.push({
      id: "owner",
      header: "Owner",
      accessorFn: (p) => p.owner,
      meta: { priority: 2, mono: true, label: "Owner" },
    });
  cols.push(
    {
      id: "latest",
      header: "Latest",
      accessorFn: (p) => p.latestVersion ?? "",
      meta: { priority: 1, mono: true, label: "Latest" },
      cell: ({ row }) =>
        row.original.latestVersion ?? (
          <span className="font-sans text-fg-muted">None live</span>
        ),
    },
    {
      id: "tags",
      // The feed adapter's declaration: npm calls its channel pointers dist-tags.
      header: capabilities.channels === "dist-tags" ? "Dist-tags" : "Tags",
      accessorFn: (p) => p.tags.map((t) => t.tag).join(" "),
      enableSorting: false,
      meta: { priority: 2, label: "Tags" },
      cell: ({ row }) =>
        row.original.tags.length ? (
          <span className="flex flex-wrap gap-1">
            {row.original.tags.map((t) => (
              <StatusPill key={t.tag} tone="neutral" icon={null} size="sm">
                {t.tag} → {t.version}
              </StatusPill>
            ))}
          </span>
        ) : (
          <span className="text-fg-muted">None</span>
        ),
    },
    {
      id: "versions",
      header: "Versions",
      accessorFn: (p) => p.versions,
      meta: { priority: 2, numeric: true, label: "Versions" },
      cell: ({ row }) =>
        row.original.liveVersions === row.original.versions
          ? formatCount(row.original.versions)
          : `${formatCount(row.original.liveVersions)} of ${formatCount(row.original.versions)}`,
    },
    {
      id: "last",
      header: "Last publish",
      accessorFn: (p) => p.lastPublishedAt ?? 0,
      meta: { priority: 2, label: "Last publish" },
      cell: ({ row }) =>
        row.original.lastPublishedAt ? (
          <Timestamp at={fromSeconds(row.original.lastPublishedAt)} />
        ) : (
          <span className="text-fg-muted">Never</span>
        ),
    },
  );
  return cols;
}

function PackagesTab({
  scope,
  eco,
  detail,
}: {
  scope: FeedScope;
  eco: FeedEcosystem;
  detail: FeedDetailDto;
}): React.ReactElement {
  // Platform scope opens on the platform's own packages; "All owners" lists every product's.
  const [ownerFilter, setOwnerFilter] = React.useState<"platform" | "all">(
    "platform",
  );
  const owner =
    scope.kind === "platform" && ownerFilter === "platform"
      ? SYSTEM_PRODUCT_SLUG
      : "";
  const query = useFeedPackages(scope, eco, "", owner);
  const capabilities = detail.capabilities;
  const columns = React.useMemo(
    () => packageColumns(scope, capabilities),
    [scope, capabilities],
  );
  const rows = query.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <DataTable<FeedPackageRow>
      id={`feed-packages-${scope.kind}`}
      caption={`${ECOSYSTEM_LABELS[eco]} packages`}
      data={rows}
      columns={columns}
      getRowId={(p) => `${p.owner}/${p.deliverableId}`}
      rowLabel={(p) => p.name}
      rowHref={(p) => packageHref(scope, eco, p.owner, p.name)}
      linkComponent={Link}
      search={{ placeholder: "Search packages" }}
      loading={query.isPending}
      error={query.isError ? query.error : undefined}
      onRetry={() => void query.refetch()}
      pagination={{
        mode: "cursor",
        hasMore: query.hasNextPage ?? false,
        loadingMore: query.isFetchingNextPage,
        onLoadMore: () => void query.fetchNextPage(),
      }}
      exportCsv={false}
      mobile="cards"
      toolbarActions={
        scope.kind === "platform" ? (
          <SegmentedControl<"platform" | "all">
            aria-label="Owner"
            size="sm"
            value={ownerFilter}
            onChange={setOwnerFilter}
            options={[
              { value: "platform", label: "Platform packages" },
              { value: "all", label: "All owners" },
            ]}
          />
        ) : undefined
      }
      empty={
        <EmptyState
          kind="first-run"
          title={`No ${ECOSYSTEM_LABELS[eco]} packages yet`}
          description={
            detail.feed.enabled
              ? "A package appears here when CI publishes its first version with pkey release publish."
              : "Enable the feed in Settings; a package appears here when CI publishes its first version with pkey release publish."
          }
          docs={docsUrl("packageFeeds")}
        />
      }
    />
  );
}

function SetupTab({
  eco,
  detail,
}: {
  eco: FeedEcosystem;
  detail: FeedDetailDto;
}): React.ReactElement {
  if (!detail.feed.baseUrl || !detail.owner)
    return (
      <EmptyState
        kind="first-run"
        title="No registry URL"
        description="This deployment has no registry host (PKG_ORIGIN), so the feed has no address to give clients."
        docs={docsUrl("packageFeedsHost")}
      />
    );
  // F-21: a non-public feed's setup names the token through an environment variable; the real
  // token appears only in the shown-once dialog on the Tokens page.
  const snippets = feedSetupSnippets(
    eco,
    {
      origin: detail.registryOrigin ?? detail.feed.baseUrl,
      owner: detail.owner,
      namespace: detail.settings.namespace,
    },
    detail.settings.accessMode === "public"
      ? { kind: "none" }
      : { kind: "env", name: TOKEN_ENV },
  );
  return (
    <div className="space-y-4">
      {detail.feed.status !== "enabled" ? (
        <Callout tone="info" title="The feed is not answering yet">
          These settings work once the feed is enabled; until then every client
          gets not-found.
        </Callout>
      ) : null}
      <SetupSnippets snippets={snippets} />
    </div>
  );
}

/**
 * Setup snippets as the console shows them: `renderFeedSetup`'s output (the same bytes
 * `pkey feeds setup` prints), each under its title, with its warning and description.
 */
export function SetupSnippets({
  snippets,
}: {
  snippets: readonly FeedSnippet[] | null;
}): React.ReactElement {
  if (snippets === null)
    return (
      <EmptyState
        kind="first-run"
        title="No setup to show"
        description="The feed's namespace has a value ingest would refuse. Correct it in Settings, under Namespace."
      />
    );
  return (
    <div className="space-y-4">
      {snippets.map((s) => (
        <section
          key={s.id}
          aria-labelledby={`setup-${s.id}`}
          className="space-y-2"
        >
          <h2 id={`setup-${s.id}`} className="text-sm font-bold text-fg-strong">
            {s.title}
          </h2>
          {s.warning ? <Callout tone="warning">{s.warning}</Callout> : null}
          {s.description ? (
            <p className="text-sm text-fg-muted">{s.description}</p>
          ) : null}
          <CodeBlock
            code={s.code}
            language={s.language}
            filename={s.filename}
            copy
          />
        </section>
      ))}
    </div>
  );
}

export function ActivityTab({
  scope,
  eco,
  filter,
  emptyTitle = "No activity on this feed yet",
}: {
  scope: FeedScope;
  eco: FeedEcosystem;
  filter?: (target: { kind: string; id: string } | null) => boolean;
  emptyTitle?: string;
}): React.ReactElement {
  const query = useFeedActivity(scope, eco);
  if (query.isPending)
    return <PageSkeleton template="table" label="activity" />;
  if (query.isError || !query.data)
    return (
      <ErrorState error={query.error} onRetry={() => void query.refetch()} />
    );
  const items = filter
    ? query.data.items.filter((i) => filter(i.target))
    : query.data.items;
  if (items.length === 0)
    return (
      <EmptyState
        kind="first-run"
        title={emptyTitle}
        description="Settings changes, rebuilds and version yanks and deprecations appear here."
      />
    );
  return (
    <Timeline
      label="Feed activity"
      items={items}
      getKey={(a) => a.id}
      getTime={(a) => fromSeconds(a.at)}
      renderItem={(a) => (
        <TimelineItem
          actor={
            a.actor.name || a.actor.email
              ? { name: a.actor.name || a.actor.email }
              : "system"
          }
          verb={verbFor(a.action)}
          target={
            a.target ? (
              <span className="font-mono text-xs">
                {a.target.kind === "package"
                  ? a.target.id.slice(eco.length + 1)
                  : ECOSYSTEM_LABELS[eco]}
              </span>
            ) : undefined
          }
          at={fromSeconds(a.at)}
          summary={a.summary || undefined}
        />
      )}
    />
  );
}
