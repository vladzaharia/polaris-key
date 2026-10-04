import * as React from "react";
import { Ban, ExternalLink, Pin } from "lucide-react";
import type {
  ChannelPolicyDto,
  DistributionMatrix,
  ReleaseArtifactDto,
  ReleaseDto,
} from "../../../api.js";
import { formatBytes, fromSeconds } from "../../../lib/format.js";
import {
  ACCESS_LABELS,
  label,
  OUTLET_KIND_LABELS,
} from "../../../lib/labels.js";
import { statusOf } from "../../../lib/status.js";
import { Button } from "../../../ui/Button.js";
import { Checkbox } from "../../../ui/Checkbox.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { Hash } from "../../../ui/Hash.js";
import { PageSkeleton, Skeleton } from "../../../ui/Skeleton.js";
import { SignedBadge } from "../../../ui/SignedBadge.js";
import { StatusPill } from "../../../ui/StatusPill.js";
import { Timestamp } from "../../../ui/Timestamp.js";
import { Breadcrumbs } from "../../components/Breadcrumbs.js";
import { EntityLink } from "../../components/EntityLink.js";
import { PageHeader } from "../../components/PageHeader.js";
import { PageTabs } from "../../components/PageTabs.js";
import { useProduct } from "../../data/hooks.js";
import { Link } from "../../router.js";
import { r } from "../../routes.js";
import {
  MATRIX_WINDOW,
  useMatrixOverlay,
  useReleaseChannels,
  useReleaseStore,
} from "./data.js";
import { PolicyDialog, type PolicyAction } from "./PolicyDialog.js";
import { servingChannels } from "./ReleasesPage.js";
import {
  APP,
  buildSummary,
  LocationBadges,
  optionOfRelease,
  platformName,
} from "./shared.js";

/**
 * A release record (ADMIN.md §6.3.2, T3): builds as cards with their files (RBD-1, RBD-2), the
 * packs it pins as links to the pack record, where each channel serves it, and its matrix row.
 * Tabs are route segments: `release/releases/:id/[builds|packs|channels|distribution]`.
 */

export type ReleaseTab = "builds" | "packs" | "channels" | "distribution";

/** True for a file that only vouches for another (a signature or checksum). */
export function isSidecar(a: Pick<ReleaseArtifactDto, "role">): boolean {
  return a.role === "signature" || a.role === "checksum";
}

function FileRow({ a }: { a: ReleaseArtifactDto }): React.ReactElement {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-xs">
      <span className="min-w-0 break-all font-mono text-sm text-fg-strong">
        {a.name}
      </span>
      {a.role && a.role !== "payload" ? (
        <StatusPill tone="neutral">{a.role}</StatusPill>
      ) : null}
      <span className="tabular-nums text-fg-muted">
        {a.sizeBytes === null ? "—" : formatBytes(a.sizeBytes)}
      </span>
      {a.sha256 ? <Hash value={a.sha256} label="SHA-256" /> : null}
      <LocationBadges locations={a.locations} file={a.name} />
      {a.access ? (
        <span className="text-fg-muted">
          Access: {label(ACCESS_LABELS, a.access)}
        </span>
      ) : null}
    </li>
  );
}

function BuildsTab({
  slug,
  release,
}: {
  slug: string;
  release: ReleaseDto;
}): React.ReactElement {
  const [sidecars, setSidecars] = React.useState(false);
  const count = release.artifacts.filter(isSidecar).length;
  const visible = sidecars
    ? release.artifacts
    : release.artifacts.filter((a) => !isSidecar(a));
  const known = new Set(release.builds.map((b) => b.buildId));
  const loose = visible.filter((a) => !a.buildId || !known.has(a.buildId));
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-fg-muted">
          {release.builds.length
            ? `${release.builds.length} ${release.builds.length === 1 ? "build" : "builds"}, ${release.artifacts.length} ${release.artifacts.length === 1 ? "file" : "files"}`
            : "No builds declared: these are the files the GitHub sync indexed."}
        </p>
        {count ? (
          <Checkbox
            checked={sidecars}
            onCheckedChange={setSidecars}
            label={`Show signatures and checksums (${count})`}
          />
        ) : null}
      </div>
      {release.builds.map((b) => {
        const files = visible.filter((a) => a.buildId === b.buildId);
        return (
          <section
            key={b.buildId}
            aria-label={`Build ${b.buildId}`}
            className="rounded-lg border border-border bg-surface-raised"
          >
            <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
              <h2 className="text-sm font-bold text-fg-strong">
                {buildSummary(b)}
              </h2>
              <span className="font-mono text-xs text-fg-muted">
                {b.buildId}
              </span>
            </header>
            <div className="px-4">
              {b.embeds && b.embeds.length ? (
                <p className="pt-2 text-xs text-fg-muted">
                  Embeds{" "}
                  {b.embeds.map((e, i) => (
                    <React.Fragment key={e}>
                      {i ? ", " : null}
                      <EntityLink
                        slug={slug}
                        kind="deliverable"
                        id={e}
                        label={<span className="font-mono">{e}</span>}
                      />
                    </React.Fragment>
                  ))}
                </p>
              ) : null}
              {files.length ? (
                <ul className="divide-y divide-border">
                  {files.map((a) => (
                    <FileRow key={a.artifactId} a={a} />
                  ))}
                </ul>
              ) : (
                <p className="py-2 text-xs text-fg-muted">
                  No files recorded for this build.
                </p>
              )}
            </div>
          </section>
        );
      })}
      {loose.length ? (
        <section
          aria-label={
            release.builds.length ? "Files not tied to a build" : "Files"
          }
          className="rounded-lg border border-border bg-surface-raised px-4"
        >
          {release.builds.length ? (
            <h2 className="pt-2 text-sm font-bold text-fg-strong">
              Files not tied to a build
            </h2>
          ) : null}
          <ul className="divide-y divide-border">
            {loose.map((a) => (
              <FileRow key={a.artifactId} a={a} />
            ))}
          </ul>
        </section>
      ) : null}
      {!release.builds.length && !release.artifacts.length ? (
        <EmptyState
          kind="first-run"
          title="No files"
          description="This release lists no builds and no files."
        />
      ) : null}
    </div>
  );
}

function PacksTab({
  slug,
  release,
}: {
  slug: string;
  release: ReleaseDto;
}): React.ReactElement {
  const pins = release.pins ?? [];
  return (
    <div className="space-y-4">
      <p className="text-sm text-fg">
        Content API{" "}
        {release.contentApi !== null && release.contentApi !== undefined ? (
          <span className="font-mono">{release.contentApi}</span>
        ) : (
          <span className="text-fg-muted">none</span>
        )}
      </p>
      {pins.length ? (
        <ul className="divide-y divide-border rounded-lg border border-border bg-surface-raised">
          {pins.map((p) => (
            <li
              key={p.pack}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm"
            >
              <EntityLink
                slug={slug}
                kind="deliverable"
                id={p.pack}
                label={<span className="font-mono">{p.pack}</span>}
              />
              <span aria-hidden className="text-fg-muted">
                →
              </span>
              <EntityLink
                slug={slug}
                kind="pack-release"
                deliverable={p.pack}
                id={p.packReleaseId}
                label={
                  <span
                    className={
                      p.packYank ? "font-mono line-through" : "font-mono"
                    }
                  >
                    {p.packVersion ?? p.packReleaseId}
                  </span>
                }
              />
              {p.packYank ? (
                <StatusPill tone="neutral">Yanked</StatusPill>
              ) : null}
              <StatusPill tone={p.required ? "info" : "neutral"}>
                {p.required ? "Required" : "Optional"}
              </StatusPill>
              <span className="text-xs text-fg-muted">
                Delivery: {p.delivery}
              </span>
              <Hash value={p.recordSha256} label="record SHA-256" />
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          kind="first-run"
          title="No packs pinned"
          description="This app release pins no pack release. Pins come from the release's signed record, written in CI."
        />
      )}
    </div>
  );
}

function ChannelsTab({
  slug,
  release,
  channels,
  loading,
  error,
  onRetry,
}: {
  slug: string;
  release: ReleaseDto;
  channels: ChannelPolicyDto[];
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}): React.ReactElement {
  if (loading) return <Skeleton className="h-32 w-full" />;
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  if (!channels.length)
    return (
      <EmptyState
        kind="first-run"
        title="No channels yet"
        description="Channels appear once the product has a release configuration."
      />
    );
  return (
    <div className="space-y-3">
      <ul className="divide-y divide-border rounded-lg border border-border bg-surface-raised">
        {channels.map((c) => {
          const on = Object.entries(c.byPlatform)
            .filter(([, id]) => id === release.releaseId)
            .map(([p]) => platformName(p));
          const served = on.length > 0 || c.resolved === release.releaseId;
          return (
            <li key={c.channel} className="space-y-1 px-4 py-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono font-bold text-fg-strong">
                  {c.channel}
                </span>
                {c.pointer === release.releaseId ? (
                  c.pinned ? (
                    <StatusPill tone="accent" icon={Pin}>
                      Pinned here
                    </StatusPill>
                  ) : (
                    <StatusPill tone="info">Pointer</StatusPill>
                  )
                ) : null}
                {served ? (
                  <StatusPill tone="success">Served</StatusPill>
                ) : (
                  <StatusPill tone="neutral">Not served</StatusPill>
                )}
              </div>
              <p className="text-fg-muted">
                {on.length
                  ? `Serves ${release.version} on ${on.join(", ")}.`
                  : served
                    ? `Serves ${release.version}.`
                    : release.yank
                      ? `${release.version} is yanked: only a pin serves it.`
                      : `${c.channel} serves a newer release, or ${release.version} is not on it.`}
              </p>
            </li>
          );
        })}
      </ul>
      <Link
        to={r.channels(slug)}
        className="text-sm text-accent-fg underline-offset-4 hover:underline"
      >
        Open Channels
      </Link>
    </div>
  );
}

function DistributionTab({
  slug,
  release,
  matrix,
  loading,
  error,
  onRetry,
}: {
  slug: string;
  release: ReleaseDto;
  matrix: DistributionMatrix | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}): React.ReactElement {
  if (loading) return <Skeleton className="h-32 w-full" />;
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  if (!matrix) return <></>;
  if (!matrix.outlets.length)
    return (
      <EmptyState
        kind="first-run"
        title="No outlets declared"
        description="Outlets come from the distribution manifest; declare one to see where this release is available."
      />
    );
  if (!matrix.releases.some((x) => x.releaseId === release.releaseId))
    return (
      <EmptyState
        kind="not-found"
        title={`Not in the newest ${MATRIX_WINDOW} releases tracked by Distribution`}
        description="Distribution tracks availability and rollouts for the newest releases only."
      />
    );
  const cells = matrix.cells.filter((c) => c.releaseId === release.releaseId);
  return (
    <div className="space-y-3">
      <ul className="divide-y divide-border rounded-lg border border-border bg-surface-raised">
        {matrix.outlets.map((o) => {
          const cell = cells.find((c) => c.outletId === o.outletId);
          const avail = cell?.availability
            ? statusOf("availability", cell.availability)
            : null;
          const rollout = cell?.rollouts[0];
          const ready = cell?.readiness ?? null;
          return (
            <li
              key={o.outletId}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm"
            >
              <span className="min-w-40 font-bold text-fg-strong">
                {label(OUTLET_KIND_LABELS, o.kind)}{" "}
                <span className="font-mono text-xs font-normal text-fg-muted">
                  {o.outletId}
                </span>
              </span>
              {avail ? (
                <StatusPill tone={avail.tone} icon={avail.icon}>
                  {avail.label}
                </StatusPill>
              ) : (
                <span className="text-fg-muted">Not available</span>
              )}
              {rollout ? (
                <StatusPill domain="rollout" state={rollout.state}>
                  {statusOf("rollout", rollout.state).label}{" "}
                  {rollout.rolloutBp < 10000
                    ? `${rollout.rolloutBp / 100} %`
                    : ""}
                </StatusPill>
              ) : null}
              {ready ? (
                <span className="text-xs text-fg-muted">
                  Readiness:{" "}
                  {
                    statusOf(
                      "readiness",
                      ready.holds ? "holds" : ready.warning ? "warning" : "ok",
                    ).label
                  }
                  {ready.warning ? ` · ${ready.warning}` : ""}
                </span>
              ) : null}
              <Link
                to={r.matrix(slug, {
                  cell: `${release.releaseId}:${o.outletId}`,
                })}
                className="ml-auto text-xs text-accent-fg underline-offset-4 hover:underline"
              >
                Open in matrix
              </Link>
            </li>
          );
        })}
      </ul>
      <Link
        to={r.matrix(slug)}
        className="text-sm text-accent-fg underline-offset-4 hover:underline"
      >
        Open the distribution matrix
      </Link>
    </div>
  );
}

export function ReleaseRecord({
  slug,
  id,
  tab,
}: {
  slug: string;
  id: string;
  tab: string | undefined;
}): React.ReactElement {
  const store = useReleaseStore(slug);
  const channelsQuery = useReleaseChannels(slug);
  const product = useProduct(slug);
  const distributionOn =
    product.data?.services?.distribution?.enabled !== false;
  const current: ReleaseTab =
    tab === "packs" || tab === "channels" || tab === "distribution"
      ? tab
      : "builds";
  const matrix = useMatrixOverlay(
    slug,
    distributionOn && current === "distribution",
  );
  const [action, setAction] = React.useState<PolicyAction | null>(null);

  const releases = (store.data?.releases ?? []).filter(
    (x) => x.deliverable === APP,
  );
  const release = releases.find((x) => x.releaseId === id);
  const appChannels =
    channelsQuery.data?.deliverables.find((d) => d.deliverable === APP)
      ?.channels ?? [];
  const crumbs = (
    <Breadcrumbs
      items={[
        { label: "Releases", to: r.releases(slug) },
        { label: release?.version ?? id },
      ]}
    />
  );

  if (store.isPending)
    return <PageSkeleton template="record" label="release" />;
  if (store.error && !store.data)
    return (
      <div className="space-y-6">
        <PageHeader eyebrow={crumbs} title={id} />
        <ErrorState
          error={store.error}
          onRetry={() => void store.refetch()}
          context={{ thing: "Release", collectionHref: r.releases(slug) }}
        />
      </div>
    );
  if (!release)
    return (
      <div className="space-y-6">
        <PageHeader eyebrow={crumbs} title="Release not found" />
        <EmptyState
          kind="not-found"
          title={`No release ${id} in ${product.data?.name ?? slug}`}
          description="It may have been removed from the store by a resync, or the link is wrong."
          primaryAction={
            <Button asChild variant="outline">
              <Link to={r.releases(slug)}>All releases</Link>
            </Button>
          }
        />
      </div>
    );

  const serving = servingChannels(release.releaseId, appChannels);
  const pins = release.pins?.length ?? 0;
  const tabs = [
    {
      value: "builds",
      label: "Builds & files",
      to: r.release(slug, id, "builds"),
    },
    {
      value: "packs",
      label: "Packs",
      count: pins,
      to: r.release(slug, id, "packs"),
    },
    {
      value: "channels",
      label: "Channels",
      to: r.release(slug, id, "channels"),
    },
    ...(distributionOn
      ? [
          {
            value: "distribution",
            label: "Distribution",
            to: r.release(slug, id, "distribution"),
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-6" data-template="record">
      <PageHeader
        eyebrow={crumbs}
        title={<span className="font-mono">{release.version}</span>}
        titleAside={
          <span className="inline-flex flex-wrap items-center gap-2">
            {release.yank ? (
              <StatusPill tone="neutral" icon={Ban}>
                Yanked
              </StatusPill>
            ) : serving.length ? (
              <StatusPill tone="success">
                Live on {serving.join(", ")}
              </StatusPill>
            ) : null}
            {release.signer ? (
              <SignedBadge kid={release.signer.kid} by="the release key" />
            ) : null}
          </span>
        }
        description={
          <>
            {release.title ? <>“{release.title}” · </> : null}
            {release.publishedAt ? (
              <>
                published{" "}
                <Timestamp
                  at={fromSeconds(release.publishedAt)}
                  format="detail"
                />
              </>
            ) : (
              "not published"
            )}
            {release.seq !== null ? <> · seq {release.seq}</> : null}
          </>
        }
        meta={
          <>
            {release.yank ? (
              // The reason is the point of a yank: it reads as a warning, not muted meta.
              <span className="text-sm font-bold text-warning">
                Yanked: {release.yank.reason}
              </span>
            ) : null}
            {release.sourceUrl ? (
              <a
                href={release.sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-sm text-accent-fg underline-offset-4 hover:underline"
              >
                GitHub release
                <ExternalLink aria-hidden className="size-3.5" />
                <span className="sr-only">(opens a new tab)</span>
              </a>
            ) : null}
          </>
        }
        primaryAction={
          <Button
            disabledReason={
              release.yank
                ? "A yanked release can't be promoted. Unyank it, or pin it."
                : undefined
            }
            onClick={() =>
              setAction({
                kind: "promote",
                deliverable: APP,
                releaseId: release.releaseId,
              })
            }
          >
            Promote…
          </Button>
        }
        secondaryActions={[
          {
            label: "Pin on…",
            onSelect: () =>
              setAction({
                kind: "pin",
                deliverable: APP,
                releaseId: release.releaseId,
              }),
          },
          ...(release.yank
            ? [
                {
                  label: "Unyank…",
                  onSelect: () =>
                    setAction({
                      kind: "unyank",
                      release: optionOfRelease(release),
                    }),
                },
              ]
            : []),
        ]}
        dangerActions={
          release.yank
            ? []
            : [
                {
                  label: "Yank…",
                  onSelect: () =>
                    setAction({
                      kind: "yank",
                      release: optionOfRelease(release),
                    }),
                },
              ]
        }
        tabs={<PageTabs label="Release" items={tabs} value={current} />}
        sticky
      />
      {current === "builds" ? (
        <BuildsTab slug={slug} release={release} />
      ) : null}
      {current === "packs" ? <PacksTab slug={slug} release={release} /> : null}
      {current === "channels" ? (
        <ChannelsTab
          slug={slug}
          release={release}
          channels={appChannels}
          loading={channelsQuery.isPending}
          error={channelsQuery.error}
          onRetry={() => void channelsQuery.refetch()}
        />
      ) : null}
      {current === "distribution" && distributionOn ? (
        <DistributionTab
          slug={slug}
          release={release}
          matrix={matrix.data}
          loading={matrix.isPending}
          error={matrix.error}
          onRetry={() => void matrix.refetch()}
        />
      ) : null}
      <PolicyDialog
        slug={slug}
        action={action}
        channels={appChannels}
        releases={releases.map(optionOfRelease)}
        onClose={() => setAction(null)}
      />
    </div>
  );
}
