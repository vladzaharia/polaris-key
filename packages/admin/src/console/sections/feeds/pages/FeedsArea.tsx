/**
 * Package feeds (F-11, plans/F-01.md §6.9, notes/S-12 §10.1): the Feeds overview and the area's
 * router, in either scope.
 *
 * - **Platform → Package feeds** (`#/platform/feeds…`): the system product's feeds (the platform's
 *   own packages, our SDKs) and the platform policy. Before the bootstrap there is no system
 *   product: the page offers to set the feeds up.
 * - **Ship builds → Packages** (`#/p/:slug/distribution/feeds…`): the product's feeds, one card
 *   each (F-34.7), listed in the sidebar whenever Distribution is on; with `packageFeeds` off the
 *   page offers to turn it on.
 *
 * Under the overview, one page per feed (`FeedPage`) and the package record (`PackageRecord`).
 * `FeedNav` links the overview and every feed page, so each feed is a page of its own.
 */

import * as React from "react";
import { KeyRound, LayoutGrid } from "lucide-react";
import { CardsSkeleton, pollPackages } from "./PackagesOverview.js";
import type {
  FeedEcosystem,
  FeedSummary,
  FeedsOverviewDto,
} from "../../../../api.js";
import { formatCount, fromSeconds } from "../../../../lib/format.js";
import { cn } from "../../../../lib/cn.js";
import { Button } from "../../../../ui/Button.js";
import { StatTile } from "../../../../ui/charts/StatTile.js";
import { CopyButton } from "../../../../ui/CopyButton.js";
import { DataTable, type DataColumn } from "../../../../ui/data-table/index.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { PageSkeleton } from "../../../../ui/Skeleton.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { Timestamp } from "../../../../ui/Timestamp.js";
import { useLoadingAnnouncement } from "../../../../ui/loading.js";
import { PageHeader } from "../../../../ui/PageHeader.js";
import { useWriteGate } from "../../../access/useCan.js";
import { useProduct } from "../../../data/hooks.js";
import { Link, navigate } from "../../../router.js";
import { type RouteChild } from "../../../routes.js";
import { useFeedsOverview } from "../data.js";
import { FeedPage } from "./FeedPage.js";
import {
  ECOSYSTEMS,
  ECOSYSTEM_ICONS,
  ECOSYSTEM_LABELS,
  feedAccessText,
  OFF_REASONS,
  feedHref,
  isEcosystem,
  overviewHref,
  tokensHref,
  takeAfterWrite,
  type FeedScope,
} from "../model/model.js";
import { PackagesEmpty } from "./PackagesEmpty.js";
import { ProductFeed } from "./ProductFeed.js";
import { useMoreTabs } from "./useMoreTabs.js";
import { BootstrapEmpty, OwnersPanel } from "./FeedsOwners.js";
import { PackageFeedsOff } from "./PackageFeedsOff.js";
import { PackageRecord } from "./PackageRecord.js";
import {
  FeedCards,
  provisionedFeeds,
  useFirstFeedArrived,
} from "./PackagesOverview.js";
import { CleanupNotice } from "./CleanupDryRun.js";
import { InstallCards } from "./InstallCards.js";
import { PackagesFoot } from "./PackagesFoot.js";
import { TurnOffFeeds } from "./TurnOffFeeds.js";
import { RegistryTokensPage } from "./RegistryTokens.js";

/** The area's page for a route: the overview, a feed, or a package. */
export function FeedsArea({
  scope,
  eco,
  tab,
  child,
}: {
  scope: FeedScope;
  eco?: string;
  tab?: string;
  child?: RouteChild;
}): React.ReactElement {
  const product = useProduct(scope.kind === "product" ? scope.slug : null);
  // Product scope: the sidebar lists the page whenever Distribution is on; with `packageFeeds`
  // off it offers to turn the feeds on instead of showing empty feeds.
  if (scope.kind === "product" && product.data?.packageFeeds === false)
    return <PackageFeedsOff slug={scope.slug} name={product.data.name} />;
  if (eco === undefined) return <FeedsOverview scope={scope} />;
  // F-21: `…/feeds/tokens` is the scope's registry tokens, beside the feed pages.
  if (eco === "tokens") return <RegistryTokensPage scope={scope} />;
  if (!isEcosystem(eco))
    return (
      <div className="space-y-6">
        <PageHeader title="Feed not found" />
        <EmptyState
          kind="not-found"
          title={`There is no ${eco} feed`}
          description="The registry serves npm, PyPI, Docker / OCI, Swift, Maven / Gradle and Godot."
          primaryAction={
            <Button asChild variant="outline">
              <Link to={overviewHref(scope)}>All package feeds</Link>
            </Button>
          }
        />
      </div>
    );
  if (child) {
    const owner = scope.kind === "platform" ? child.ids[0]! : scope.slug;
    const name = child.ids[child.ids.length - 1]!;
    return (
      <PackageRecord
        scope={scope}
        eco={eco}
        owner={owner}
        name={name}
        tab={child.tab}
      />
    );
  }
  if (scope.kind === "product")
    return <ProductFeed slug={scope.slug} scope={scope} eco={eco} tab={tab} />;
  return <FeedPage scope={scope} eco={eco} tab={tab} />;
}

/**
 * The area's sub-navigation bar: the links between the overview and every feed page (one page
 * per feed), in the tab area under each page's title (F-38). A `nav` of real links with `aria-current`, each with its
 * ecosystem's icon; Overview stands apart behind a separator, the bar sits on a rule, and the
 * current page is marked three ways (accent fill, bold label, an accent bar on the rule), never by
 * colour alone. Owner decision (F-12): a bar of links, not a dropdown in the title.
 */
export function FeedNav({
  scope,
  current,
}: {
  scope: FeedScope;
  current: "overview" | "tokens" | (typeof ECOSYSTEMS)[number];
}): React.ReactElement {
  // A product's tabs are the feeds it declared (a feed exists because a package is); the
  // platform lists every ecosystem.
  const overview = useFeedsOverview(scope, scope.kind === "product");
  const tabs =
    scope.kind === "platform"
      ? ECOSYSTEMS
      : overview.data
        ? provisionedFeeds(overview.data).map((f) => f.ecosystem)
        : ECOSYSTEMS.filter((e) => e === current);
  const [barRef, more] = useMoreTabs(tabs.length);
  const link = (it: {
    key: string;
    label: string;
    icon: typeof LayoutGrid;
    to: string;
  }) => {
    const Icon = it.icon;
    const active = it.key === current;
    return (
      <li key={it.key}>
        <Link
          to={it.to}
          aria-current={active ? "page" : undefined}
          data-active={active ? "" : undefined}
          className={cn(
            "relative inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-t-md px-2 text-sm",
            "after:absolute after:inset-x-1.5 after:bottom-0 after:h-0.5 after:rounded-full",
            "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus",
            active
              ? "bg-accent-subtle font-medium text-fg-strong after:bg-accent"
              : "text-fg-muted after:bg-transparent hover:bg-hover hover:text-fg-strong",
          )}
        >
          <Icon
            aria-hidden
            className={cn("size-4 shrink-0", active && "text-accent")}
          />
          {it.label}
        </Link>
      </li>
    );
  };
  return (
    <nav
      ref={barRef}
      aria-label="Package feeds"
      data-more-tabs={more ? "" : undefined}
      className={cn(
        "pk-scroll scroll-px-10 overflow-x-auto border-b border-border",
        // A fade at the edge says there are more tabs to scroll to.
        more &&
          "[mask-image:linear-gradient(to_right,black_calc(100%-2.5rem),transparent)]",
      )}
    >
      <ul className="flex items-center gap-1 pe-6">
        {link({
          key: "overview",
          label: "Overview",
          icon: LayoutGrid,
          to: overviewHref(scope),
        })}
        {tabs.length ? (
          <li
            aria-hidden
            className="mx-1.5 h-5 w-px shrink-0 bg-border-strong"
          />
        ) : null}
        {tabs.map((e) =>
          link({
            key: e,
            label: ECOSYSTEM_LABELS[e],
            icon: ECOSYSTEM_ICONS[e],
            to: feedHref(scope, e),
          }),
        )}
        {/* F-21: the registry tokens clients of non-public feeds present. */}
        <li aria-hidden className="mx-1.5 h-5 w-px shrink-0 bg-border-strong" />
        {link({
          key: "tokens",
          label: "Tokens",
          icon: KeyRound,
          to: tokensHref(scope),
        })}
      </ul>
    </nav>
  );
}

/** A feed's status as a pill, never colour alone. */
export function FeedStatusPill({
  feed,
}: {
  feed: Pick<FeedSummary, "status">;
}): React.ReactElement {
  if (feed.status === "enabled")
    return <StatusPill tone="success">Enabled</StatusPill>;
  if (feed.status === "unavailable")
    return <StatusPill tone="warning">Not available</StatusPill>;
  return <StatusPill tone="neutral">Off</StatusPill>;
}

function overviewColumns(scope: FeedScope): DataColumn<FeedSummary>[] {
  return [
    {
      id: "feed",
      header: "Feed",
      accessorFn: (f) => ECOSYSTEM_LABELS[f.ecosystem],
      meta: { priority: 1, primary: true, label: "Feed" },
      cell: ({ row }) => {
        const Icon = ECOSYSTEM_ICONS[row.original.ecosystem];
        return (
          <span className="inline-flex items-center gap-2">
            <Icon aria-hidden className="size-4 text-fg-muted" />
            {ECOSYSTEM_LABELS[row.original.ecosystem]}
          </span>
        );
      },
    },
    {
      id: "status",
      header: "Status",
      accessorFn: (f) => f.status,
      meta: { priority: 1, label: "Status" },
      cell: ({ row }) => (
        <span className="flex flex-col items-start gap-0.5">
          <FeedStatusPill feed={row.original} />
          {row.original.reason && row.original.reason !== "feed-off" ? (
            <span className="text-xs text-fg-muted">
              {OFF_REASONS[row.original.reason]}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      id: "packages",
      header: "Packages",
      accessorFn: (f) => f.packages,
      meta: { priority: 1, numeric: true, label: "Packages" },
      cell: ({ row }) => formatCount(row.original.packages),
    },
    {
      id: "versions",
      header: "Versions",
      accessorFn: (f) => f.versions,
      meta: { priority: 2, numeric: true, label: "Versions" },
      cell: ({ row }) => formatCount(row.original.versions),
    },
    {
      id: "last",
      header: "Last publish",
      accessorFn: (f) => f.lastPublishedAt ?? 0,
      meta: { numeric: true, priority: 2, label: "Last publish" },
      cell: ({ row }) =>
        row.original.lastPublishedAt ? (
          <Timestamp at={fromSeconds(row.original.lastPublishedAt)} />
        ) : (
          <span className="text-fg-muted">Never</span>
        ),
    },
    {
      id: "access",
      header: "Access",
      accessorFn: (f) => f.accessMode,
      meta: { priority: 2, label: "Access" },
      cell: ({ row }) => (
        <StatusPill tone="neutral" icon={null}>
          {feedAccessText(row.original.accessMode)}
        </StatusPill>
      ),
    },
    {
      id: "url",
      header: "Registry URL",
      accessorFn: (f) => f.baseUrl ?? "",
      meta: { priority: 3, label: "Registry URL", mono: true },
      enableSorting: false,
      cell: ({ row }) =>
        row.original.baseUrl ? (
          <span className="inline-flex max-w-full items-center gap-1">
            <span className="truncate font-mono text-xs">
              {row.original.baseUrl}
            </span>
            <CopyButton
              value={row.original.baseUrl}
              label={`Copy the ${ECOSYSTEM_LABELS[row.original.ecosystem]} registry URL`}
              size="xs"
            />
          </span>
        ) : (
          <span className="text-fg-muted">
            {scope.kind === "platform" ? "Not set up" : "No registry host"}
          </span>
        ),
    },
  ];
}

/** The Feeds overview (T2 with a summary strip). */
export function FeedsOverview({
  scope,
}: {
  scope: FeedScope;
}): React.ReactElement {
  // A product's page re-reads while nothing is declared or a feed waits for its first package.
  const query = useFeedsOverview(
    scope,
    true,
    scope.kind === "product" ? pollPackages : undefined,
  );
  const product = useProduct(scope.kind === "product" ? scope.slug : null);
  useLoadingAnnouncement("package feeds", query.isPending);
  const [turningOff, setTurningOff] = React.useState(false);
  const gate = useWriteGate(
    "ship",
    scope.kind === "product" ? scope.slug : null,
  );
  // After Turn on moved the page back to its cards: focus the page title.
  React.useEffect(() => {
    if (scope.kind !== "product" || !query.data) return;
    if (!takeAfterWrite("page", scope.slug)) return;
    const id = requestAnimationFrame(() => {
      const h1 = document.querySelector<HTMLElement>("main h1");
      if (h1) {
        h1.tabIndex = -1;
        h1.focus();
      }
    });
    return () => cancelAnimationFrame(id);
  }, [query.data, scope]);
  const columns = React.useMemo(() => overviewColumns(scope), [scope]);
  const data = query.data;
  const arrived = useFirstFeedArrived(data, scope.kind === "product");
  const host = data?.registryOrigin
    ? new URL(data.registryOrigin).host
    : "the registry host";
  const provisioned =
    data && scope.kind === "product" ? provisionedFeeds(data) : [];
  const header = (
    <PageHeader
      title={scope.kind === "platform" ? "Package feeds" : "Packages"}
      titleAside={
        scope.kind === "product" && provisioned.length ? (
          <span className="text-sm text-fg-muted">
            {provisioned.length} {provisioned.length === 1 ? "feed" : "feeds"}
          </span>
        ) : undefined
      }
      description={
        scope.kind === "platform"
          ? `Polaris Key's own SDKs and tools, on ${host}. Policy set here covers every product.`
          : undefined
      }
      secondaryActions={
        scope.kind === "product"
          ? [
              {
                label: "Registry tokens",
                icon: <KeyRound aria-hidden />,
                onSelect: () => void navigate(tokensHref(scope)),
              },
            ]
          : []
      }
      tabs={
        // A product's tabs are the feeds it declared: none while loading, failing or empty.
        scope.kind === "product" && provisioned.length === 0 ? undefined : (
          <FeedNav scope={scope} current="overview" />
        )
      }
      refetching={query.isFetching && !query.isPending}
    />
  );
  if (query.isPending)
    return (
      <div className="space-y-6">
        {header}
        {scope.kind === "product" ? (
          <CardsSkeleton />
        ) : (
          <PageSkeleton template="table" label="package feeds" />
        )}
      </div>
    );
  if (query.isError || !data) {
    const forbidden =
      (query.error as { status?: number } | null)?.status === 403;
    return (
      <div className="space-y-6">
        {header}
        <ErrorState
          error={query.error}
          // A refusal to read does not change on a retry.
          onRetry={forbidden ? undefined : () => void query.refetch()}
          context={{
            area: "distribution",
            thing: scope.kind === "product" ? "Packages" : "Package feeds",
            read: true,
          }}
        />
      </div>
    );
  }
  if (scope.kind === "platform" && data.owner === null)
    return (
      <div className="space-y-6">
        {header}
        <BootstrapEmpty />
      </div>
    );
  if (scope.kind === "product") {
    const feeds = provisionedFeeds(data);
    return (
      <div className="space-y-6">
        {header}
        {feeds.length ? (
          <>
            <CleanupNotice scope={scope} />
            <FeedCards scope={scope} feeds={feeds} focusFirst={arrived} />
            <InstallCards
              scope={scope}
              owner={scope.slug}
              feeds={feeds}
              canCreate={!gate.disabledReason}
            />
            <PackagesFoot
              onTurnOff={() => setTurningOff(true)}
              disabledReason={gate.disabledReason}
            />
            <TurnOffFeeds
              open={turningOff}
              onOpenChange={setTurningOff}
              slug={scope.slug}
              name={product.data?.name ?? scope.slug}
              feedCount={feeds.length}
              packageCount={feeds.reduce((n, f) => n + f.packages, 0)}
              focusOffCard
            />
          </>
        ) : (
          <PackagesEmpty
            slug={scope.slug}
            name={product.data?.name ?? scope.slug}
          />
        )}
      </div>
    );
  }
  const ordered = ECOSYSTEMS.map(
    (e) => data.feeds.find((f) => f.ecosystem === e)!,
  ).filter(Boolean);
  return (
    <div className="space-y-6">
      {header}
      <SummaryStrip data={data} />
      <DataTable<FeedSummary>
        id={`feeds-overview-${scope.kind}`}
        caption="Package feeds"
        data={ordered}
        columns={columns}
        getRowId={(f) => f.ecosystem}
        rowLabel={(f) => ECOSYSTEM_LABELS[f.ecosystem]}
        rowHref={(f) => feedHref(scope, f.ecosystem)}
        linkComponent={Link}
        exportCsv={false}
        mobile="cards"
      />
      {scope.kind === "platform" && data.owners ? (
        <OwnersPanel owners={data.owners} />
      ) : null}
    </div>
  );
}

function SummaryStrip({
  data,
}: {
  data: FeedsOverviewDto;
}): React.ReactElement {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <StatTile
        label="Feeds enabled"
        value={`${data.summary.feedsEnabled} of ${data.feeds.length}`}
      />
      <StatTile label="Packages" value={formatCount(data.summary.packages)} />
      <StatTile label="Versions" value={formatCount(data.summary.versions)} />
      <StatTile
        label="Last publish"
        value={
          data.summary.lastPublishedAt ? (
            <Timestamp at={fromSeconds(data.summary.lastPublishedAt)} />
          ) : (
            "Never"
          )
        }
      />
    </div>
  );
}
