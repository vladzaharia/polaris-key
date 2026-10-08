/**
 * Package feeds (F-11, plans/F-01.md §6.9, notes/S-12 §10.1): the Feeds overview and the area's
 * router, in either scope.
 *
 * - **Platform → Package feeds** (`#/platform/feeds…`): the system product's feeds (the platform's
 *   own packages, our SDKs) and the platform policy. Before the bootstrap there is no system
 *   product: the page offers to set the feeds up.
 * - **Distribution → Package feeds** (`#/p/:slug/distribution/feeds…`): the product's feeds,
 *   listed in the sidebar while `packageFeeds` is on; with it off the page says where to turn it on.
 *
 * Under the overview, one page per feed (`FeedPage`) and the package record (`PackageRecord`).
 * `FeedNav` links the overview and every feed page, so each feed is a page of its own.
 */

import * as React from "react";
import { KeyRound, LayoutGrid, Rocket } from "lucide-react";
import type { FeedSummary, FeedsOverviewDto } from "../../../api.js";
import { docsUrl } from "../../../lib/docsLinks.js";
import { errorCopy } from "../../../lib/errorCopy.js";
import { formatCount, fromSeconds } from "../../../lib/format.js";
import { cn } from "../../../lib/cn.js";
import { Button } from "../../../ui/Button.js";
import { StatTile } from "../../../ui/charts/StatTile.js";
import { ConfirmDialog } from "../../../ui/ConfirmDialog.js";
import { CopyButton } from "../../../ui/CopyButton.js";
import { DataTable, type DataColumn } from "../../../ui/data-table/index.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { PageSkeleton } from "../../../ui/Skeleton.js";
import { StatusPill } from "../../../ui/StatusPill.js";
import { Timestamp } from "../../../ui/Timestamp.js";
import { toast } from "../../../ui/toast.js";
import { useLoadingAnnouncement } from "../../../ui/loading.js";
import { PageHeader } from "../../../ui/PageHeader.js";
import { useProduct } from "../../data/hooks.js";
import { mutate } from "../../data/mutations.js";
import { Link } from "../../router.js";
import { r, type RouteChild } from "../../routes.js";
import { intentOf } from "../../pages/core/confirmGate.js";
import { useFeedsOverview } from "./data.js";
import { FeedPage } from "./FeedPage.js";
import {
  ECOSYSTEMS,
  ECOSYSTEM_ICONS,
  ECOSYSTEM_LABELS,
  FEED_ACCESS_LABELS,
  OFF_REASONS,
  feedHref,
  isEcosystem,
  overviewHref,
  tokensHref,
  type FeedScope,
} from "./model.js";
import { PackageRecord } from "./PackageRecord.js";
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
  // Product scope: the page exists while `packageFeeds` is on (the sidebar lists it then); a deep
  // link with it off says where to turn it on instead of showing empty feeds.
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
  return <FeedPage scope={scope} eco={eco} tab={tab} />;
}

function PackageFeedsOff({
  slug,
  name,
}: {
  slug: string;
  name: string;
}): React.ReactElement {
  return (
    <div className="space-y-6">
      <PageHeader title="Package feeds" />
      <EmptyState
        kind="first-run"
        service="distribution"
        title="Package feeds are off for this product"
        description="Turn them on in Services, under Distribution. Each feed then gets its own settings here."
        primaryAction={
          <Button asChild>
            <Link to={r.services(slug)}>Open Services</Link>
          </Button>
        }
        docs={docsUrl("packageFeeds")}
      />
    </div>
  );
}

/**
 * The area's sub-navigation bar: the links between the overview and every feed page (one page
 * per feed), above each page's title. A `nav` of real links with `aria-current`, each with its
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
            "relative inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-t-md px-2.5 text-sm",
            "after:absolute after:inset-x-1.5 after:bottom-0 after:h-0.5 after:rounded-full",
            "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus",
            active
              ? "bg-accent-subtle font-bold text-fg-strong after:bg-accent"
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
      aria-label="Package feeds"
      className="pk-scroll overflow-x-auto border-b border-border"
    >
      <ul className="flex items-center gap-1">
        {link({
          key: "overview",
          label: "Overview",
          icon: LayoutGrid,
          to: overviewHref(scope),
        })}
        <li aria-hidden className="mx-1.5 h-5 w-px shrink-0 bg-border-strong" />
        {ECOSYSTEMS.map((e) =>
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
          {FEED_ACCESS_LABELS[row.original.accessMode] ??
            row.original.accessMode}
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
  const query = useFeedsOverview(scope);
  useLoadingAnnouncement("package feeds", query.isPending);
  const columns = React.useMemo(() => overviewColumns(scope), [scope]);
  const data = query.data;
  const host = data?.registryOrigin
    ? new URL(data.registryOrigin).host
    : "the registry host";
  const header = (
    <PageHeader
      eyebrow={<FeedNav scope={scope} current="overview" />}
      title="Package feeds"
      description={
        scope.kind === "platform"
          ? `The SDKs and tools Polaris Key ships, on ${host}. Policy set here applies to every product's feeds.`
          : `On ${host}.`
      }
      refetching={query.isFetching && !query.isPending}
    />
  );
  if (query.isPending)
    return (
      <div className="space-y-6">
        {header}
        <PageSkeleton template="table" label="package feeds" />
      </div>
    );
  if (query.isError || !data)
    return (
      <div className="space-y-6">
        {header}
        <ErrorState
          error={query.error}
          onRetry={() => void query.refetch()}
          context={{ area: "distribution", thing: "Package feeds" }}
        />
      </div>
    );
  if (scope.kind === "platform" && data.owner === null)
    return (
      <div className="space-y-6">
        {header}
        <BootstrapEmpty />
      </div>
    );
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

/** Platform scope: every product whose package feeds have been switched, the system one first. */
function OwnersPanel({
  owners,
}: {
  owners: NonNullable<FeedsOverviewDto["owners"]>;
}): React.ReactElement {
  return (
    <section
      aria-labelledby="feeds-owners"
      className="rounded-lg border border-border bg-surface-raised p-5"
    >
      <h2 id="feeds-owners" className="text-sm font-bold text-fg-strong">
        Owners
      </h2>
      <p className="mt-1 text-sm text-fg-muted">
        Each under its own path on the registry host.
      </p>
      <ul className="mt-3 divide-y divide-border">
        {owners.map((o) => (
          <li
            key={o.slug}
            className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
          >
            <span className="flex items-center gap-2">
              {o.system ? (
                <span className="text-fg-strong">{o.name}</span>
              ) : (
                <Link
                  to={r.packageFeeds(o.slug)}
                  className="text-accent-fg underline-offset-4 hover:underline"
                >
                  {o.name}
                </Link>
              )}
              <span className="font-mono text-xs text-fg-muted">{o.slug}</span>
              {o.system ? (
                <StatusPill tone="neutral" icon={null} size="sm">
                  Platform
                </StatusPill>
              ) : null}
            </span>
            {o.packageFeeds ? (
              <StatusPill tone="success" size="sm">
                On
              </StatusPill>
            ) : (
              <StatusPill tone="neutral" size="sm">
                Off
              </StatusPill>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Platform scope before the bootstrap: the system product does not exist yet. */
function BootstrapEmpty(): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <EmptyState
        kind="first-run"
        title="The platform's package feeds are not set up"
        description="Setting them up creates the platform's own product, which owns the SDK packages, and one feed per ecosystem with the platform's namespaces."
        primaryAction={
          <Button
            iconStart={<Rocket aria-hidden />}
            onClick={() => setOpen(true)}
          >
            Set up platform feeds…
          </Button>
        }
        docs={docsUrl("packageFeeds")}
      />
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        intent={intentOf("feed.bootstrap")}
        title="Set up the platform's package feeds?"
        consequences={[
          "Creates the platform's own product, polaris-key, with a signing key sealed under the platform key. It stays out of the product switcher and the Products registry.",
          "Turns on Release, Distribution and package feeds for it, with one feed per ecosystem under the platform's namespaces.",
          "Running it again changes nothing an operator has set since.",
        ]}
        confirmLabel="Set up platform feeds"
        describeError={(e) => errorCopy(e)}
        onConfirm={async () => {
          await mutate("bootstrapPlatformFeeds");
          toast.success("The platform's package feeds are set up");
        }}
      />
    </>
  );
}
