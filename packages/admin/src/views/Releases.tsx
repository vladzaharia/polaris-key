import * as React from "react";
import { buildLabel } from "@polaris-key/manifest";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  GitBranch,
  Info,
  Package,
} from "lucide-react";
import type {
  ProductDetail,
  ProductSyncState,
  ReleaseChannelDto,
  ReleaseDto,
  ReleaseHealth,
  ReleaseHealthCheck,
} from "../api.js";
import { api } from "../api.js";
import { useResource } from "../context.js";
import { docsUrl } from "../lib/docsLinks.js";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  DataTable,
  EmptyState,
  Skeleton,
  type ColumnDef,
} from "../components/ui/index.js";
import { ResyncButton } from "./releases/ResyncButton.js";
import { ReleaseBuilds } from "./releases/ReleaseBuilds.js";
import { ChannelsPanel } from "./releases/ChannelsPanel.js";
import {
  PolicyActionDialog,
  type PolicyAction,
} from "./releases/PolicyActionDialog.js";
import { releaseSourceOf } from "./products/util.js";

/**
 * Releases view: the release TRUTH STORE, the channels that serve from it, and the
 * manifest-driven status around them.
 *
 * The store (`release_metadata`, `release_builds`, `release_artifacts`, the yanks and the channel
 * policy) is what Polaris Key believes the product publishes. Since P2-05 it is what resolution
 * reads: the build, file and blob routes, the download route, the appcast and the version check
 * all apply its yanks and pins, and the signed channel feed (P3-03) is composed from it. This
 * view shows it release by release — each release's builds and the files under them — and
 * channel by channel, with what each channel serves on every platform as the admin API resolves
 * it (the console never recomputes resolution).
 *
 * The operator controls here — promote, pin, unpin, yank, unyank, the minimum supported
 * version, the critical flag, the rollback floor — are P2-05's admin operations, each behind a
 * confirmation that states its effect. Every one claims the channel row for the operator, so a
 * resync leaves it alone until "Revert to manifest" hands it back.
 *
 * Release config itself (repo coordinates, channel rules) is still edited in `.pkey/release.*`
 * and applied by a resync. Health and sync describe how the store's belief was formed and
 * whether it is current; they follow it rather than standing in for it.
 */
export function Releases({ slug }: { slug: string }): React.ReactElement {
  const { data, loading, error, reload } = useResource(`product:${slug}`, () =>
    api.product(slug).then((r) => r.product),
  );
  const health = useResource(`release-health:${slug}`, () =>
    api.releaseHealth(slug).then((r) => r.health),
  );
  const store = useResource(`releases:${slug}`, () => api.releases(slug));
  const channels = useResource(`release-channels:${slug}`, () =>
    api.releaseChannels(slug),
  );
  const [action, setAction] = React.useState<PolicyAction | null>(null);

  if (loading && !data) return <ReleasesSkeleton />;

  if (error && !data) {
    return (
      <section className="space-y-6">
        <Header slug={slug} product={null} />
        <EmptyState
          icon={<AlertTriangle aria-hidden />}
          title="Couldn’t load the product"
          description={error}
          action={
            <Button variant="outline" onClick={reload}>
              Try again
            </Button>
          }
        />
      </section>
    );
  }

  if (!data) {
    return (
      <section className="space-y-6">
        <Header slug={slug} product={null} />
        <EmptyState
          icon={<Package aria-hidden />}
          title="No product details available"
        />
      </section>
    );
  }

  return (
    <section className="space-y-6">
      <Header slug={slug} product={data} />
      <ReleaseStoreCard
        releases={store.data?.releases ?? []}
        channels={store.data?.channels ?? []}
        loading={store.loading && !store.data}
        error={store.error}
        onRetry={store.reload}
        onAction={setAction}
      />
      <ChannelsPanel
        data={channels.data}
        releases={store.data?.releases ?? []}
        floors={store.data?.floors ?? []}
        loading={channels.loading && !channels.data}
        error={channels.error}
        onRetry={channels.reload}
        onAction={setAction}
      />
      <PolicyActionDialog
        slug={slug}
        action={action}
        releases={store.data?.releases ?? []}
        onClose={() => setAction(null)}
      />
      <ManifestNote />
      <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
        <ReleaseHealthCard
          health={health.data ?? null}
          loading={health.loading}
          error={health.error}
          onRetry={health.reload}
        />
        <SyncStateCard sync={data.setup?.sync ?? null} />
      </div>
      <DistributionCard product={data} />
    </section>
  );
}

/**
 * The truth store. Every row is a release a feed could be rendered from, so it shows the things a
 * feed decision turns on: the version, whether it is published or yanked, how many builds and
 * files were indexed, and which channels the sync last saw pointing at it. Expanding a row shows
 * its builds and the files under each (`ReleaseBuilds`).
 *
 * The sync's channel map is rendered twice on purpose — as badges on the release each channel
 * points at, and as a list below. The badges answer "what does this release serve"; the list
 * answers "what does `beta` currently ship", including a channel pointing at a release id the
 * store no longer holds, which is invisible in a per-row projection. What a channel serves NOW,
 * per platform and after policy, is the Channels panel's job.
 */
function ReleaseStoreCard({
  releases,
  channels,
  loading,
  error,
  onRetry,
  onAction,
}: {
  releases: ReleaseDto[];
  channels: ReleaseChannelDto[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onAction: (action: PolicyAction) => void;
}): React.ReactElement {
  const [open, setOpen] = React.useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string): void =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const channelsByRelease = React.useMemo(() => {
    const map = new Map<string, string[]>();
    for (const c of channels) {
      map.set(c.releaseId, [...(map.get(c.releaseId) ?? []), c.channel]);
    }
    return map;
  }, [channels]);

  const versionOf = React.useMemo(() => {
    const map = new Map(releases.map((r) => [r.releaseId, r.version]));
    return (releaseId: string): string | null => map.get(releaseId) ?? null;
  }, [releases]);

  const columns: ColumnDef<ReleaseDto>[] = [
    {
      id: "expand",
      header: <span className="sr-only">Builds</span>,
      className: "w-8 pr-0",
      cell: (r) => {
        const expanded = open.has(r.releaseId);
        return (
          <button
            type="button"
            onClick={() => toggle(r.releaseId)}
            aria-expanded={expanded}
            aria-label={`${expanded ? "Hide" : "Show"} builds of ${r.version}`}
            className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >
            {expanded ? (
              <ChevronDown className="size-4" aria-hidden />
            ) : (
              <ChevronRight className="size-4" aria-hidden />
            )}
          </button>
        );
      },
    },
    {
      id: "version",
      header: "Version",
      accessor: (r) => r.version,
      sortable: true,
      cell: (r) => (
        <span className="inline-flex flex-wrap items-center gap-1">
          <span className="font-mono text-xs">{r.version}</span>
          {r.yank ? (
            <Badge
              variant="destructive"
              title={`Yanked by ${r.yank.by} ${formatStamp(r.yank.at)}`}
            >
              Yanked: {r.yank.reason}
            </Badge>
          ) : null}
        </span>
      ),
    },
    {
      id: "title",
      header: "Title",
      accessor: (r) => r.title ?? "",
      sortable: true,
      cell: (r) =>
        r.title ? (
          <span className="font-medium">{r.title}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "published",
      header: "Published",
      accessor: (r) => r.publishedAt ?? 0,
      sortable: true,
      cell: (r) => formatStamp(r.publishedAt ?? undefined),
    },
    {
      id: "status",
      header: "Status",
      accessor: (r) => r.status,
      sortable: true,
      cell: (r) => <StatusBadge status={r.status} />,
    },
    {
      id: "builds",
      header: "Builds",
      accessor: (r) => r.builds.length,
      sortable: true,
      cell: (r) => String(r.builds.length),
    },
    {
      id: "artifacts",
      header: "Files",
      accessor: (r) => r.artifacts.length,
      sortable: true,
      cell: (r) => String(r.artifacts.length),
    },
    {
      id: "channels",
      header: "Channels",
      cell: (r) => {
        const on = channelsByRelease.get(r.releaseId) ?? [];
        return on.length ? (
          <div className="flex flex-wrap gap-1">
            {on.map((c) => (
              <Badge key={c} variant="primary">
                {c}
              </Badge>
            ))}
          </div>
        ) : (
          <span className="text-muted-foreground">—</span>
        );
      },
    },
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      cell: (r) =>
        r.yank ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onAction({ kind: "unyank", release: r })}
            aria-label={`Unyank ${r.version}`}
          >
            Unyank
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onAction({ kind: "yank", release: r })}
            aria-label={`Yank ${r.version}`}
          >
            Yank…
          </Button>
        ),
    },
  ];

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Package className="size-4 text-muted-foreground" aria-hidden />
          <CardTitle>Releases</CardTitle>
        </div>
        <CardDescription>
          What Polaris Key knows each release ships — builds, files, hashes and
          where the bytes live — read from the store every download and update
          feed resolves against, without a GitHub round-trip.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && !loading ? (
          <div className="space-y-3 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
            <p className="font-medium text-warning">
              Couldn’t load the release store
            </p>
            <p className="text-muted-foreground">{error}</p>
            <Button variant="outline" size="sm" onClick={onRetry}>
              Retry
            </Button>
          </div>
        ) : (
          <>
            <DataTable
              columns={columns}
              rows={releases}
              rowKey={(r) => r.releaseId}
              expanded={(r) =>
                open.has(r.releaseId) ? <ReleaseBuilds release={r} /> : null
              }
              loading={loading}
              filterable={releases.length > 8}
              filterPlaceholder="Filter releases…"
              empty={
                <EmptyState
                  icon={<Package aria-hidden />}
                  title="Nothing synced yet"
                  description="Resync from the linked repo, or publish a release there — the store fills from the repo, never by hand."
                  className="rounded-none border-0"
                />
              }
            />
            {channels.length ? (
              <div className="space-y-2">
                <p className="text-xs uppercase tracking-wider text-muted-foreground">
                  Channel map
                </p>
                <ul className="flex flex-wrap gap-2">
                  {channels.map((c) => (
                    <li key={c.channel}>
                      <Badge variant="outline">
                        <span className="font-medium">{c.channel}</span>
                        <span aria-hidden>→</span>
                        <span className="font-mono">
                          {versionOf(c.releaseId) ?? c.releaseId}
                        </span>
                      </Badge>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Header({
  slug,
  product,
}: {
  slug: string;
  product: ProductDetail | null;
}): React.ReactElement {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="space-y-1">
        <h2 className="text-2xl font-semibold tracking-tight">Releases</h2>
        <p className="text-sm text-muted-foreground">
          Release distribution &amp; minters for{" "}
          <span className="font-mono">{slug}</span>.
        </p>
      </div>
      {/* Resync only exists for repo-linked products (`release/resync.ts` 422s otherwise),
          and there is nothing to resync before the product row has loaded. */}
      {product ? (
        <ResyncButton
          slug={slug}
          linked={releaseSourceOf(product) === "github"}
        />
      ) : null}
    </header>
  );
}

/**
 * Explains the source of truth for release config. Editing happens in the repo's `.pkey/`
 * manifest, then is applied with the Resync action — there is no per-field release form because
 * the admin API exposes no release CRUD.
 */
function ManifestNote(): React.ReactElement {
  return (
    <Card className="border-primary/30 bg-primary/5">
      <CardContent className="flex gap-3 p-4">
        <Info className="mt-0.5 size-4 shrink-0 text-accent-fg" aria-hidden />
        <div className="space-y-1 text-sm">
          <p className="font-medium">
            Release config is managed from the repo manifest.
          </p>
          <p className="text-muted-foreground">
            GitHub coordinates (owner / repo / binary name / channel workflow /
            Sparkle key) and edge-mint recipes live in the product’s{" "}
            <span className="font-mono">.pkey/release</span> file. Edit them
            there, then use{" "}
            <span className="font-medium">Resync from repo</span> above to
            re-apply. These values are not editable directly from the admin
            panel.{" "}
            <a
              className="underline underline-offset-2 hover:text-foreground"
              href={docsUrl("manifestNote")}
              target="_blank"
              rel="noreferrer"
            >
              Learn more
            </a>
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function ReleaseHealthCard({
  health,
  loading,
  error,
  onRetry,
}: {
  health: ReleaseHealth | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}): React.ReactElement {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <CheckCircle2
              className="size-4 text-muted-foreground"
              aria-hidden
            />
            <CardTitle>Release health</CardTitle>
          </div>
          {health ? <StatusBadge status={health.status} /> : null}
        </div>
        <CardDescription>
          GitHub App access, the latest release’s artifacts (declared or as
          published), and Sparkle material.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading && !health ? <Skeleton className="h-28 w-full" /> : null}
        {error && !health ? (
          <div className="space-y-3 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
            <p className="font-medium text-warning">Health check failed</p>
            <p className="text-muted-foreground">{error}</p>
            <Button variant="outline" size="sm" onClick={onRetry}>
              Retry
            </Button>
          </div>
        ) : null}
        {health ? (
          <>
            {health.release ? (
              <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
                <Row term="Latest tag" mono>
                  {health.release.tag}
                </Row>
                <Row term="Assets">{String(health.release.assetCount)}</Row>
              </dl>
            ) : null}
            <ul className="space-y-2">
              {health.checks.map((item) => (
                <HealthCheckRow key={item.id} check={item} />
              ))}
            </ul>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function HealthCheckRow({
  check,
}: {
  check: ReleaseHealthCheck;
}): React.ReactElement {
  return (
    <li className="rounded-md border border-border p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{check.label}</span>
        <StatusBadge status={check.status} />
      </div>
      {check.message ? (
        <p className="mt-1 text-xs text-muted-foreground">{check.message}</p>
      ) : null}
      {check.missing?.length ? (
        <p className="mt-1 text-xs text-warning">
          Missing: {check.missing.join(", ")}
        </p>
      ) : null}
      {check.files?.length ? (
        <ul
          className="mt-2 space-y-1 text-xs"
          aria-label={`${check.label} files`}
        >
          {check.files.map((file) => {
            const facts =
              file.platform || file.arch
                ? [
                    buildLabel({
                      platform: file.platform,
                      arch: file.arch,
                      format: file.format,
                    }).long,
                  ]
                : [file.format].filter(Boolean);
            return (
              <li
                key={file.name}
                className="flex flex-wrap items-baseline justify-between gap-x-3"
              >
                <span className="break-all font-mono">{file.name}</span>
                {facts.length ? (
                  <span className="text-muted-foreground">
                    {facts.join(" · ")}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {isFloorCheck(check.id) ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Lower or clear the floor from the channel’s actions in the Channels
          panel above.
        </p>
      ) : null}
    </li>
  );
}

/** The anti-rollback floor checks (R6-10, P0-02): `channel-regressed[-<channel>]` and
 *  `channel-floor-unverified-<channel>` — the ones an operator answers with the floor action. */
function isFloorCheck(id: string): boolean {
  return (
    id === "channel-regressed" ||
    id.startsWith("channel-regressed-") ||
    id.startsWith("channel-floor-unverified-")
  );
}

function SyncStateCard({
  sync,
}: {
  sync: ProductSyncState | null;
}): React.ReactElement {
  const changed = sync?.changedPaths ?? [];
  const updated = sync?.updated ?? [];
  const errors = sync?.errors ?? [];
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <GitBranch className="size-4 text-muted-foreground" aria-hidden />
            <CardTitle>Manifest sync</CardTitle>
          </div>
          {sync?.status ? <StatusBadge status={sync.status} /> : null}
        </div>
        <CardDescription>
          Last `.pkey/` sync attempt, changed paths, and applied sections.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {sync ? (
          <>
            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
              <Row term="Source">{sync.source ?? "—"}</Row>
              <Row term="Last checked">
                {formatStamp(sync.lastCheckedAt ?? undefined)}
              </Row>
              <Row term="Last synced">
                {formatStamp(sync.lastSyncedAt ?? undefined)}
              </Row>
              <Row term="Commit" mono>
                {sync.commitSha ?? "—"}
              </Row>
            </dl>
            <SyncList title="Changed paths" values={changed} mono />
            <SyncList title="Updated sections" values={updated} />
            <SyncList title="Errors" values={errors} tone="warning" />
            {sync.message ? (
              <p className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
                {sync.message}
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            No repo sync attempt has been recorded yet.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function SyncList({
  title,
  values,
  mono,
  tone,
}: {
  title: string;
  values: string[];
  mono?: boolean;
  tone?: "warning";
}): React.ReactElement | null {
  if (!values.length) return null;
  return (
    <div className="space-y-2">
      <p className="text-xs uppercase tracking-wider text-muted-foreground">
        {title}
      </p>
      <ul className="flex flex-wrap gap-2">
        {values.slice(0, 12).map((value) => (
          <li key={value}>
            <Badge variant={tone === "warning" ? "warning" : "outline"}>
              <span className={mono ? "font-mono" : undefined}>{value}</span>
            </Badge>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The release-adjacent product metadata the admin API DOES expose: signing key id and the
 * per-product defaults. The compatibility window used to be a row here too; it is now editable
 * under Update settings, and a read-only copy of a value with an editor elsewhere is exactly
 * the kind of duplicate that goes stale, so this card points at it instead of restating it.
 */
function DistributionCard({
  product,
}: {
  product: ProductDetail;
}): React.ReactElement {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <GitBranch className="size-4 text-muted-foreground" aria-hidden />
          <CardTitle>Distribution &amp; compatibility</CardTitle>
        </div>
        <CardDescription>
          Read-only product metadata that governs releases and update checks.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
          <Row term="Product">{product.name}</Row>
          <Row term="Slug" mono>
            {product.slug}
          </Row>
          <Row term="Signing key id" mono>
            {product.signingKid || "—"}
          </Row>
          <Row term="Default max offline days">
            {String(product.defaultMaxOfflineDays)}
          </Row>
          <Row term="Default device limit">
            {product.defaultDeviceLimit === 0
              ? "unlimited"
              : String(product.defaultDeviceLimit)}
          </Row>
          {/* Manifest metadata only — not an authorization input (see ProductOverview). */}
          <Row term="Admin group (metadata only)" mono>
            {product.adminGroup ?? "—"}
          </Row>
          <Row term="Last modified">{formatStamp(product.modifiedAt)}</Row>
        </dl>
        <p className="mt-4 text-sm text-muted-foreground">
          The compatibility window (min / max client version) now lives under{" "}
          <span className="font-medium">Update → Update settings</span>, beside
          the feed access modes it is intersected with.
        </p>
      </CardContent>
    </Card>
  );
}

function Row({
  term,
  children,
  mono,
}: {
  term: string;
  children: React.ReactNode;
  mono?: boolean;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs uppercase tracking-wider text-muted-foreground">
        {term}
      </dt>
      <dd className={mono ? "break-words font-mono text-sm" : "text-sm"}>
        {children}
      </dd>
    </div>
  );
}

function formatStamp(epochSeconds: number | undefined): string {
  if (!epochSeconds) return "—";
  try {
    return new Date(epochSeconds * 1000).toLocaleString();
  } catch {
    return "—";
  }
}

function StatusBadge({ status }: { status: string }): React.ReactElement {
  const normalized = status.toLowerCase();
  const variant =
    normalized === "ok" || normalized === "healthy"
      ? "success"
      : normalized === "warning" ||
          normalized === "needs-setup" ||
          normalized === "not-configured" ||
          normalized === "missing"
        ? "warning"
        : normalized === "error"
          ? "destructive"
          : "outline";
  return <Badge variant={variant}>{status}</Badge>;
}

function ReleasesSkeleton(): React.ReactElement {
  return (
    <section className="space-y-6" aria-busy="true">
      <div className="space-y-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-72" />
      </div>
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-64 w-full" />
    </section>
  );
}
