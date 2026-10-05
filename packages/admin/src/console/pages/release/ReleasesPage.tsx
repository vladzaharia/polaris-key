import * as React from "react";
import { ExternalLink, GitBranch } from "lucide-react";
import type {
  ChannelPolicyDto,
  ReleaseDto,
  ResyncResult,
} from "../../../api.js";
import { fromSeconds } from "../../../lib/format.js";
import { useLoadingAnnouncement } from "../../../ui/loading.js";
import {
  DataTable,
  type DataColumn,
  type RowActionItem,
} from "../../../ui/data-table/index.js";
import { announce } from "../../../ui/LiveRegion.js";
import { Timestamp } from "../../../ui/Timestamp.js";
import { Version } from "../../../ui/Version.js";
import { PageHeader } from "../../components/PageHeader.js";
import { useProduct } from "../../data/hooks.js";
import { Link, codecs, useSearchParam } from "../../router.js";
import { r } from "../../routes.js";
import { CollectionTemplate } from "../../templates/Collection.js";
import { useTableUrlState } from "../../useTableUrlState.js";
import {
  useReleaseChannels,
  useReleaseHealth,
  useReleaseStore,
} from "./data.js";
import { FirstReleasePanel } from "./FirstReleasePanel.js";
import { PolicyDialog, type PolicyAction } from "./PolicyDialog.js";
import {
  isRepoLinked,
  RepoSyncDrawer,
  ResyncButton,
  SyncSummary,
} from "./RepoSync.js";
import {
  APP,
  optionOfRelease,
  PlatformGlyphs,
  platformName,
  ReleaseSigner,
} from "./shared.js";

/**
 * Release → Releases (ADMIN.md §6.3.1, T2): the app's releases in the truth store, one table.
 * The version links to the release record; the channels, builds, packs and signer are columns;
 * Promote, Pin and Yank are row actions (REL-1, REL-4, REL-5, REL-10). Repo health and the last
 * sync live in the Repo sync drawer (`?panel=sync`), product metadata in Settings (REL-2, REL-3).
 *
 * Before the first release the table gives way to the guided `FirstReleasePanel` (EXPERIENCE.md
 * §0.4 S2), which polls the store; the release that ends the wait is announced politely
 * ("0.1.0 published from CI", §7.1) and nothing moves under the pointer.
 */

const FACETS = ["channel", "platform", "yank"] as const;

/** The channels serving a release on at least one platform, from the server's resolution. */
export function servingChannels(
  releaseId: string,
  channels: ChannelPolicyDto[],
): string[] {
  return channels
    .filter(
      (c) =>
        c.resolved === releaseId ||
        Object.values(c.byPlatform).includes(releaseId),
    )
    .map((c) => c.channel);
}

export function ReleasesPage({ slug }: { slug: string }): React.ReactElement {
  const store = useReleaseStore(slug);
  const channelsQuery = useReleaseChannels(slug);
  const health = useReleaseHealth(slug);
  const product = useProduct(slug);
  const [panel, setPanel] = useSearchParam("panel", codecs.string());
  const [state, setState] = useTableUrlState("releases", { facets: FACETS });
  const [action, setAction] = React.useState<PolicyAction | null>(null);
  const [result, setResult] = React.useState<ResyncResult | null>(null);
  useLoadingAnnouncement("releases", store.isPending);
  // A resync's result opens the Repo sync drawer, which lists what changed (RSY-3).
  const onResync = (r: ResyncResult | null): void => {
    setResult(r);
    if (r) setPanel("sync");
  };

  const releases = React.useMemo(
    () => (store.data?.releases ?? []).filter((x) => x.deliverable === APP),
    [store.data],
  );
  const appChannels = React.useMemo(
    () =>
      channelsQuery.data?.deliverables.find((d) => d.deliverable === APP)
        ?.channels ?? [],
    [channelsQuery.data],
  );
  const linked = isRepoLinked(product.data);
  const firstRun = !!store.data && !store.error && releases.length === 0;

  // The wait completes out loud: once the panel has been up, the first release is announced.
  const waited = React.useRef(false);
  React.useEffect(() => {
    if (firstRun) {
      waited.current = true;
      return;
    }
    if (!waited.current || releases.length === 0) return;
    waited.current = false;
    const first = [...releases].sort(
      (a, b) => (b.seq ?? b.publishedAt ?? 0) - (a.seq ?? a.publishedAt ?? 0),
    )[0]!;
    announce(`${first.version} published from CI`);
  }, [firstRun, releases]);

  const channelNames = [
    ...new Set([
      ...appChannels.map((c) => c.channel),
      ...releases.map((x) => x.channel).filter((c): c is string => !!c),
    ]),
  ];
  const platforms = [
    ...new Set(
      releases.flatMap((x) => x.builds.map((b) => b.platform ?? "any")),
    ),
  ];

  const columns: DataColumn<ReleaseDto>[] = [
    {
      id: "version",
      header: "Version",
      accessorFn: (x) => x.version,
      // Versions sort by publish order, not as text ("1.10.0" after "1.9.0").
      sortingFn: (a, b) =>
        (a.original.seq ?? a.original.publishedAt ?? 0) -
        (b.original.seq ?? b.original.publishedAt ?? 0),
      meta: {
        priority: 1,
        primary: true,
        label: "Version",
        alwaysVisible: true,
      },
      cell: ({ row }) => (
        <Version value={row.original.version} yanked={!!row.original.yank} />
      ),
    },
    {
      id: "source",
      header: () => <span className="sr-only">Source</span>,
      enableSorting: false,
      meta: { priority: 2, label: "Source release" },
      cell: ({ row }) =>
        row.original.sourceUrl ? (
          <a
            href={row.original.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center text-fg-muted hover:text-fg-strong"
          >
            <ExternalLink aria-hidden className="size-3.5" />
            <span className="sr-only">
              {row.original.version} on GitHub (opens a new tab)
            </span>
          </a>
        ) : null,
    },
    {
      id: "title",
      header: "Title",
      accessorFn: (x) => x.title ?? "",
      meta: { priority: 3, label: "Title" },
      cell: ({ row }) =>
        row.original.title ? (
          <span
            className="line-clamp-2 min-w-[10rem] max-w-[18rem]"
            title={row.original.title}
          >
            {row.original.title}
          </span>
        ) : (
          <span className="text-fg-muted">—</span>
        ),
    },
    {
      id: "channel",
      header: "Channels",
      enableSorting: false,
      meta: {
        priority: 1,
        label: "Channels",
        csv: (x) => servingChannels(x.releaseId, appChannels).join(" "),
      },
      cell: ({ row }) => {
        const on = servingChannels(row.original.releaseId, appChannels);
        return on.length ? (
          <span className="whitespace-nowrap text-sm">
            {on.map((c, i) => (
              <React.Fragment key={c}>
                {i > 0 ? ", " : null}
                <span>{c}</span>
              </React.Fragment>
            ))}
          </span>
        ) : (
          <span className="text-fg-muted">—</span>
        );
      },
    },
    {
      id: "published",
      header: "Published",
      accessorFn: (x) => x.publishedAt ?? 0,
      meta: { numeric: true, priority: 2, label: "Published" },
      cell: ({ row }) =>
        row.original.publishedAt ? (
          <Timestamp at={fromSeconds(row.original.publishedAt)} />
        ) : (
          <span className="text-fg-muted">—</span>
        ),
    },
    {
      id: "platform",
      header: "Builds",
      enableSorting: false,
      meta: {
        priority: 2,
        label: "Builds",
        csv: (x) => x.builds.map((b) => b.platform ?? "any").join(" "),
      },
      cell: ({ row }) =>
        row.original.builds.length ? (
          <PlatformGlyphs
            iconsOnly
            platforms={row.original.builds.map((b) => b.platform)}
            label={`Builds of ${row.original.version}`}
          />
        ) : (
          <span className="text-xs text-fg-muted">
            {row.original.artifacts.length}{" "}
            {row.original.artifacts.length === 1 ? "file" : "files"}
          </span>
        ),
    },
    {
      id: "packs",
      header: "Packs",
      accessorFn: (x) => x.pins?.length ?? 0,
      meta: { priority: 3, numeric: true, label: "Packs" },
      cell: ({ row }) => {
        const n = row.original.pins?.length ?? 0;
        return n ? (
          `${n} ${n === 1 ? "pin" : "pins"}`
        ) : (
          <span className="text-fg-muted">—</span>
        );
      },
    },
    {
      id: "signed",
      header: "Signed",
      enableSorting: false,
      meta: {
        priority: 2,
        label: "Signed",
        csv: (x) => x.signer?.kid ?? "",
      },
      cell: ({ row }) => (
        <ReleaseSigner signer={row.original.signer} truncateKid />
      ),
    },
  ];

  const rowActions = (x: ReleaseDto): RowActionItem[] => [
    {
      label: "Promote…",
      disabledReason: x.yank
        ? "A yanked release can't be promoted. Unyank it, or pin it."
        : undefined,
      onSelect: () =>
        setAction({
          kind: "promote",
          deliverable: APP,
          releaseId: x.releaseId,
        }),
    },
    {
      label: "Pin on…",
      onSelect: () =>
        setAction({ kind: "pin", deliverable: APP, releaseId: x.releaseId }),
    },
    { type: "separator" },
    x.yank
      ? {
          label: "Unyank…",
          onSelect: () =>
            setAction({ kind: "unyank", release: optionOfRelease(x) }),
        }
      : {
          label: "Yank…",
          tone: "danger",
          onSelect: () =>
            setAction({ kind: "yank", release: optionOfRelease(x) }),
        },
  ];

  return (
    <CollectionTemplate
      header={
        <PageHeader
          title="Releases"
          titleAside={
            store.data && !firstRun ? (
              <span className="text-sm tabular-nums text-fg-muted">
                {releases.length}
              </span>
            ) : null
          }
          meta={
            <>
              <SyncSummary health={health.data} product={product.data} />
              <button
                type="button"
                onClick={() => setPanel("sync")}
                className="inline-flex items-center gap-1 text-sm text-accent-fg underline-offset-4 hover:underline"
              >
                <GitBranch aria-hidden className="size-3.5" />
                Repo sync
              </button>
            </>
          }
          primaryAction={
            <ResyncButton slug={slug} linked={linked} onResult={onResync} />
          }
          refetching={store.isFetching && !store.isPending}
        />
      }
    >
      {firstRun ? (
        <FirstReleasePanel
          slug={slug}
          productName={product.data?.name ?? slug}
          linked={linked}
          health={health}
        />
      ) : (
        <DataTable<ReleaseDto>
          id="releases"
          caption="Releases"
          data={releases}
          columns={columns}
          getRowId={(x) => x.releaseId}
          rowLabel={(x) => x.version}
          rowHref={(x) => r.release(slug, x.releaseId)}
          linkComponent={Link}
          rowActions={rowActions}
          state={state}
          onStateChange={setState}
          search={{
            placeholder: "Search version or title",
            columns: ["version", "title"],
          }}
          facets={[
            {
              id: "channel",
              label: "Channel",
              options: channelNames.map((c) => ({ value: c, label: c })),
              accessor: (x) => [
                ...servingChannels(x.releaseId, appChannels),
                ...(x.channel ? [x.channel] : []),
              ],
            },
            {
              id: "platform",
              label: "Platform",
              options: platforms.map((p) => ({
                value: p,
                label: p === "any" ? "Any platform" : platformName(p),
              })),
              accessor: (x) => x.builds.map((b) => b.platform ?? "any"),
            },
            {
              id: "yank",
              label: "Status",
              options: [
                { value: "available", label: "Available" },
                { value: "yanked", label: "Yanked" },
              ],
              accessor: (x) => (x.yank ? "yanked" : "available"),
            },
          ]}
          pagination={{ mode: "client" }}
          loading={store.isPending}
          error={store.error}
          onRetry={() => void store.refetch()}
          mobile="cards"
        />
      )}
      <RepoSyncDrawer
        open={panel === "sync"}
        onOpenChange={(open) => setPanel(open ? "sync" : "")}
        slug={slug}
        product={product.data}
        health={health.data}
        healthError={health.error}
        healthLoading={health.isPending}
        onRetryHealth={() => void health.refetch()}
        result={result}
        onResult={onResync}
      />
      <PolicyDialog
        slug={slug}
        action={action}
        channels={appChannels}
        releases={releases.map(optionOfRelease)}
        onClose={() => setAction(null)}
      />
    </CollectionTemplate>
  );
}
