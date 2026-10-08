import * as React from "react";
import { Ban, ExternalLink, OctagonPause, Pin, Undo2 } from "lucide-react";
import type {
  ActivityItem,
  ChannelPolicyDto,
  DistributionMatrix,
  ReleaseArtifactDto,
  ReleaseChannelFloorDto,
  ReleaseDto,
} from "../../../api.js";
import {
  formatBasisPoints,
  formatBytes,
  formatRelative,
  fromSeconds,
} from "../../../lib/format.js";
import {
  ACCESS_LABELS,
  label,
  OUTLET_KIND_LABELS,
} from "../../../lib/labels.js";
import { statusOf } from "../../../lib/status.js";
import { Button } from "../../../ui/Button.js";
import { Callout } from "../../../ui/Callout.js";
import { Checkbox } from "../../../ui/Checkbox.js";
import { Dialog, DialogBody, DialogFooter } from "../../../ui/Dialog.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { Hash } from "../../../ui/Hash.js";
import { RadioCards } from "../../../ui/RadioCards.js";
import { Select } from "../../../ui/Select.js";
import { PageSkeleton, Skeleton } from "../../../ui/Skeleton.js";
import { SignedBadge } from "../../../ui/SignedBadge.js";
import { StatusPill } from "../../../ui/StatusPill.js";
import { Timestamp } from "../../../ui/Timestamp.js";
import { Breadcrumbs } from "../../components/Breadcrumbs.js";
import { EntityLink } from "../../components/EntityLink.js";
import { PageHeader, type PageAction } from "../../components/PageHeader.js";
import { PageTabs } from "../../components/PageTabs.js";
import {
  canHalt,
  HaltEverywhereDialog,
  storeHalt,
  type HaltRow,
} from "../../areas/distribution/RolloutDialogs.js";
import { actorLabel } from "../../areas/distribution/format.js";
import { useProduct } from "../../data/hooks.js";
import { useActivityFeed } from "../core/Activity.js";
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
 * A release record (ADMIN.md §6.3.2, T3; EXPERIENCE.md O2): it opens on **Status** (where it is
 * live, the halt reason from the audit trail, **Halt everywhere…** and a guided **Roll back…**),
 * then builds as cards with their files (RBD-1, RBD-2), the packs it pins as links to the pack
 * record, where each channel serves it, and its matrix row.
 * Tabs are route segments: `release/releases/:id[/builds|/packs|/channels|/distribution]`; Status
 * is the bare record URL.
 */

export type ReleaseTab =
  | "status"
  | "builds"
  | "packs"
  | "channels"
  | "distribution";

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

// ── Status (UX-08, EXPERIENCE.md O2) ─────────────────────────────────────────────────────────

/** Newest first, by seq, then publish time (the pickers' order). */
function newestFirst(a: ReleaseDto, b: ReleaseDto): number {
  return (
    (b.seq ?? 0) - (a.seq ?? 0) || (b.publishedAt ?? 0) - (a.publishedAt ?? 0)
  );
}

/** The release devices fall back to: the newest earlier release that is not yanked. */
export function previousRelease(
  release: ReleaseDto,
  releases: ReleaseDto[],
): ReleaseDto | null {
  const sorted = [...releases].sort(newestFirst);
  const at = sorted.findIndex((x) => x.releaseId === release.releaseId);
  if (at < 0) return null;
  return sorted.slice(at + 1).find((x) => !x.yank) ?? null;
}

/**
 * This release's rollouts in Distribution's matrix, with each outlet's name, in outlet order.
 * `null` when the release sits outside the matrix window (its rollouts are unknown, not absent).
 */
export function rolloutRowsOf(
  matrix: DistributionMatrix | undefined,
  releaseId: string,
): HaltRow[] | null {
  if (!matrix) return null;
  if (!matrix.releases.some((x) => x.releaseId === releaseId)) return null;
  const rows: HaltRow[] = [];
  for (const o of matrix.outlets) {
    const cell = matrix.cells.find(
      (c) => c.releaseId === releaseId && c.outletId === o.outletId,
    );
    for (const rollout of cell?.rollouts ?? [])
      rows.push({ rollout, outletName: label(OUTLET_KIND_LABELS, o.kind) });
  }
  return rows;
}

/** The rollout's audit target id (worker `rollouts.ts`): `<deliverable>:<outlet>:<channel>`. */
function rolloutTarget(r: HaltRow["rollout"]): string {
  return `${r.deliverableId}:${r.outletId}:${r.channel}`;
}

/** The newest `distribution.rollout.halt` row for this rollout of this release. */
export function haltEventFor(
  items: ActivityItem[],
  r: HaltRow["rollout"],
): ActivityItem | undefined {
  const target = rolloutTarget(r);
  return items.find(
    (i) =>
      i.action === "distribution.rollout.halt" &&
      i.target?.id === target &&
      i.summary.includes(` of ${r.releaseId} on `),
  );
}

/**
 * The reason a halt's audit row carries: the auto-halt appends it after
 * "… on <outlet>/<channel>: " (worker `rollouts.ts`), ending with its source tag, which is dropped.
 * A manual halt carries none today.
 */
export function haltReason(
  item: ActivityItem,
  r: HaltRow["rollout"],
): string | null {
  const marker = ` on ${r.outletId}/${r.channel}: `;
  const at = item.summary.indexOf(marker);
  if (at < 0) return null;
  const reason = item.summary
    .slice(at + marker.length)
    .replace(/\s*\(source: [^)]*\)\s*$/, "")
    .trim();
  return reason ? reason.charAt(0).toUpperCase() + reason.slice(1) : null;
}

function isAutoHalt(r: HaltRow["rollout"]): boolean {
  return r.source === "auto-halt" || r.updatedBy.startsWith("system:");
}

/** "Direct", "Direct and Google Play", "Direct, Google Play and Steam". */
function joinNames(names: string[]): string {
  const unique = [...new Set(names)];
  if (unique.length < 2) return unique[0] ?? "";
  return `${unique.slice(0, -1).join(", ")} and ${unique[unique.length - 1]}`;
}

/**
 * The status line for a halted release: where, by whom, when, and the reason from the halt's audit
 * row, with the evidence one click away (Health for an auto-halt, the rollout's activity otherwise).
 */
function HaltLine({
  slug,
  halted,
}: {
  slug: string;
  halted: HaltRow[];
}): React.ReactElement {
  const feed = useActivityFeed(slug, {
    action: "distribution.rollout.halt",
    targetKind: "rollout",
  });
  const latest = [...halted].sort(
    (a, b) => b.rollout.updatedAt - a.rollout.updatedAt,
  )[0]!;
  const ro = latest.rollout;
  const event = haltEventFor(feed.data?.pages[0]?.items ?? [], ro);
  const auto = isAutoHalt(ro);
  const by = auto
    ? "auto-halt"
    : event
      ? event.actor.name || event.actor.email || actorLabel(ro.updatedBy)
      : actorLabel(ro.updatedBy);
  const reason = event ? haltReason(event, ro) : null;
  return (
    <Callout
      tone="danger"
      title={`Halted on ${joinNames(halted.map((h) => h.outletName))} by ${by}, ${formatRelative(fromSeconds(ro.updatedAt))}`}
      action={
        <Button asChild variant="outline" size="sm">
          {auto ? (
            <Link to={r.health(slug)}>Open Health</Link>
          ) : (
            <Link
              to={r.activity(slug, {
                kind: "rollout",
                target: rolloutTarget(ro),
              })}
            >
              View in activity
            </Link>
          )}
        </Button>
      }
    >
      {reason}
    </Callout>
  );
}

/** One fact in "Where it's live": a muted label over a bold value. */
function LiveTile({
  label: name,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="min-w-0 border-b border-border px-5 py-3">
      <dt className="truncate text-xs text-fg-muted">{name}</dt>
      <dd className="truncate text-sm font-bold tabular-nums text-fg-strong">
        {children}
      </dd>
    </div>
  );
}

/**
 * Where a channel serves the release, from the server's per-platform answer: "Every platform",
 * "Every platform but iOS" (iOS gets another release), or the platforms; `null` when it doesn't.
 */
export function servedWhere(
  c: ChannelPolicyDto,
  release: Pick<ReleaseDto, "releaseId">,
): string | null {
  const entries = Object.entries(c.byPlatform);
  const on = entries.filter(([, id]) => id === release.releaseId);
  if (!on.length)
    return c.resolved === release.releaseId && !entries.length
      ? "Every platform"
      : null;
  const elsewhere = entries
    .filter(([, id]) => id !== null && id !== release.releaseId)
    .map(([p]) => platformName(p));
  if (!elsewhere.length) return "Every platform";
  if (elsewhere.length <= 2)
    return `Every platform but ${elsewhere.join(" and ")}`;
  return on.map(([p]) => platformName(p)).join(", ");
}

/** A rollout's share as the tile reads it: "25 %", "10 % · halted", "100 %". */
function shareOf(r: HaltRow["rollout"]): string {
  if (r.state === "complete") return formatBasisPoints(10_000);
  const pct = formatBasisPoints(r.rolloutBp);
  if (r.state === "halted") return `${pct} · halted`;
  if (r.state === "paused") return `${pct} · paused`;
  return pct;
}

function StatusTab({
  slug,
  release,
  channels,
  previous,
  distributionOn,
  rows,
  matrixLoading,
  matrixError,
  onRetry,
}: {
  slug: string;
  release: ReleaseDto;
  channels: ChannelPolicyDto[];
  previous: ReleaseDto | null;
  distributionOn: boolean;
  rows: HaltRow[] | null;
  matrixLoading: boolean;
  matrixError: unknown;
  onRetry: () => void;
}): React.ReactElement {
  const halted = (rows ?? []).filter((x) => x.rollout.state === "halted");
  const serving = channels
    .map((c) => ({ channel: c.channel, where: servedWhere(c, release) }))
    .filter((c): c is { channel: string; where: string } => c.where !== null);
  const live = (rows?.length ?? 0) > 0 || serving.length > 0;
  return (
    <div className="space-y-4">
      {halted.length ? <HaltLine slug={slug} halted={halted} /> : null}
      <section
        aria-labelledby="release-live"
        className="overflow-hidden rounded-xl border border-border bg-surface-raised"
      >
        <h2
          id="release-live"
          className="border-b border-border px-5 py-3.5 text-base font-bold text-fg-strong"
        >
          Where it’s live
        </h2>
        {distributionOn && matrixError ? (
          <div className="p-4">
            <ErrorState error={matrixError} onRetry={onRetry} />
          </div>
        ) : null}
        {distributionOn && matrixLoading ? (
          <div className="p-4">
            <Skeleton className="h-12 w-full" />
          </div>
        ) : live ? (
          <dl className="-mb-px grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
            {(rows ?? []).map(({ rollout, outletName }) => (
              <LiveTile
                key={`${rollout.outletId}/${rollout.channel}`}
                label={`${outletName} · ${rollout.channel}`}
              >
                <span
                  className={
                    rollout.state === "halted" ? "text-danger" : undefined
                  }
                >
                  {shareOf(rollout)}
                </span>
              </LiveTile>
            ))}
            {serving.map((c) => (
              <LiveTile key={c.channel} label={`${c.channel} channel`}>
                {c.where}
              </LiveTile>
            ))}
            {previous ? (
              <LiveTile label="Previous release">
                <Link
                  to={r.release(slug, previous.releaseId)}
                  className="font-mono text-accent-fg underline-offset-4 hover:underline"
                >
                  {previous.version}
                </Link>
              </LiveTile>
            ) : null}
          </dl>
        ) : (
          <p className="px-5 py-3.5 text-sm text-fg-muted">
            {release.yank
              ? `${release.version} is yanked: only a pin serves it.`
              : `No channel or outlet offers ${release.version}.`}
          </p>
        )}
      </section>
    </div>
  );
}

// ── Roll back (UX-08) ────────────────────────────────────────────────────────────────────────

type RollbackKind = "pin" | "floor" | "yank";

/**
 * **Roll back…**: a guided choice between pinning a channel to the previous release, lowering the
 * channel's rollback floor, and yanking this release, each saying what it does to devices already
 * on it (EXPERIENCE.md O2). It only chooses: the chosen action opens its own confirm (`PolicyDialog`),
 * which states the effect and sends the write.
 */
export function RollBackDialog({
  open,
  release,
  previous,
  channels,
  serving,
  floors,
  onChoose,
  onClose,
}: {
  open: boolean;
  release: ReleaseDto;
  previous: ReleaseDto | null;
  /** Every channel name of the app. */
  channels: string[];
  /** The channels serving this release, first choice for the channel. */
  serving: string[];
  floors: ReleaseChannelFloorDto[];
  onChoose: (action: PolicyAction) => void;
  onClose: () => void;
}): React.ReactElement | null {
  const first = serving[0] ?? channels[0] ?? null;
  const [channel, setChannel] = React.useState<string | null>(first);
  const [kind, setKind] = React.useState<RollbackKind>(
    previous && first ? "pin" : "yank",
  );
  React.useEffect(() => {
    if (!open) return;
    setChannel(first);
    setKind(previous && first ? "pin" : "yank");
    // Each opening starts from the record's current answer; keyed on `open` alone so a refetch
    // while the dialog is open keeps the operator's choice.
  }, [open]);
  if (!open) return null;
  const v = release.version;
  const prev = previous?.version ?? null;
  const c = channel ?? "the channel";
  const floor = floors.find((f) => f.channel === channel) ?? null;
  const options = [
    {
      value: "pin" as const,
      label: prev ? `Pin ${c} to ${prev}` : `Pin ${c}`,
      description: prev
        ? `${c} stops offering ${v}; devices that haven't updated get ${prev}. Devices already on ${v} keep it.`
        : `There is no earlier release to pin ${c} to.`,
      disabled: !prev || !channel,
    },
    {
      value: "floor" as const,
      label: `Lower ${c}'s rollback floor`,
      description: floor
        ? `${c} never moves below ${floor.version}. Lowering it lets ${c} serve ${prev ?? "an older release"} again once ${v} is gone. Devices already on ${v} keep it.`
        : `${c} has no rollback floor to lower.`,
      disabled: !floor,
    },
    {
      value: "yank" as const,
      label: `Yank ${v}`,
      description: `Every channel stops offering ${v} and falls back to the newest release it may serve. Devices already on ${v} keep it.`,
    },
  ];
  const chosen = options.find((o) => o.value === kind);
  const usable = chosen && !chosen.disabled ? kind : null;
  const next: Record<RollbackKind, string> = {
    pin: "Pin…",
    floor: "Lower floor…",
    yank: "Yank…",
  };
  const choose = (): void => {
    if (!usable) return;
    if (usable === "pin" && previous && channel)
      onChoose({
        kind: "pin",
        deliverable: APP,
        channel,
        releaseId: previous.releaseId,
      });
    else if (usable === "floor" && floor && channel)
      onChoose({ kind: "lowerFloor", channel, floor });
    else if (usable === "yank")
      onChoose({ kind: "yank", release: optionOfRelease(release) });
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Roll back ${v}`}>
      <form
        noValidate
        aria-label={`Roll back ${v}`}
        onSubmit={(e) => {
          e.preventDefault();
          choose();
        }}
      >
        <DialogBody className="space-y-4">
          {channels.length > 1 ? (
            <div className="flex items-center justify-between gap-3">
              <span id="rollback-channel" className="text-sm font-bold">
                Channel
              </span>
              <Select
                aria-labelledby="rollback-channel"
                value={channel}
                onChange={setChannel}
                className="w-48"
                options={channels.map((x) => ({
                  value: x,
                  label: x,
                  description: serving.includes(x) ? `Serves ${v}` : undefined,
                }))}
              />
            </div>
          ) : null}
          <RadioCards<RollbackKind>
            aria-label="How to roll back"
            columns={1}
            value={kind}
            onChange={setKind}
            options={options}
          />
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant={kind === "yank" ? "danger" : "primary"}
            disabledReason={
              usable ? undefined : "Choose a way to roll back that applies."
            }
          >
            {next[kind]}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
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
    tab === "builds" ||
    tab === "packs" ||
    tab === "channels" ||
    tab === "distribution"
      ? tab
      : "status";
  // Every tab reads it: the header's Halt everywhere… needs this release's rollouts.
  const matrix = useMatrixOverlay(slug, distributionOn);
  const [action, setAction] = React.useState<PolicyAction | null>(null);
  const [halting, setHalting] = React.useState(false);
  const [rollingBack, setRollingBack] = React.useState(false);

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
  const previous = previousRelease(release, releases);
  const rows = distributionOn
    ? rolloutRowsOf(matrix.data, release.releaseId)
    : null;
  const haltable = (rows ?? []).filter((x) => canHalt(x.rollout));
  // A live store mirror can't be halted here, but the dialog says where to stop it (P0-47).
  const inStores = (rows ?? []).filter((x) => storeHalt(x.rollout) !== null);
  const v = release.version;
  const haltBlocked = matrix.isPending
    ? "Loading this release's rollouts."
    : matrix.error
      ? "This release's rollouts didn't load. Try again from Status."
      : !rows
        ? `${v} is older than the releases Distribution tracks.`
        : !rows.length
          ? `${v} has no rollout to halt.`
          : !haltable.length && !inStores.length
            ? `No rollout of ${v} can be halted here.`
            : undefined;
  const yanked = release.yank
    ? `${v} is yanked. Unyank it, or pin it.`
    : undefined;
  const promote: PageAction = {
    label: "Promote…",
    disabledReason: release.yank
      ? "A yanked release can't be promoted. Unyank it, or pin it."
      : undefined,
    onSelect: () =>
      setAction({
        kind: "promote",
        deliverable: APP,
        releaseId: release.releaseId,
      }),
  };
  const rollBack: PageAction = {
    label: "Roll back…",
    icon: <Undo2 aria-hidden />,
    disabledReason: yanked,
    onSelect: () => setRollingBack(true),
  };
  const pinOn: PageAction = {
    label: "Pin on…",
    onSelect: () =>
      setAction({
        kind: "pin",
        deliverable: APP,
        releaseId: release.releaseId,
      }),
  };
  const unyank: PageAction[] = release.yank
    ? [
        {
          label: "Unyank…",
          onSelect: () =>
            setAction({ kind: "unyank", release: optionOfRelease(release) }),
        },
      ]
    : [];
  const tabs = [
    {
      // The record's own URL: Status is the default, and nav.ts's record tabs (the router's
      // accepted segments) name only the other tabs.
      value: "status",
      label: "Status",
      to: r.release(slug, id),
    },
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
            {release.signer ? (
              <SignedBadge kid={release.signer.kid} by="the release key" />
            ) : null}
            {release.yank ? (
              <StatusPill tone="warning" icon={Ban}>
                Yanked
              </StatusPill>
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
          distributionOn ? (
            <Button
              variant="outline"
              className="border-danger-border text-danger"
              iconStart={<OctagonPause aria-hidden />}
              disabledReason={haltBlocked}
              onClick={() => setHalting(true)}
            >
              Halt everywhere…
            </Button>
          ) : (
            <Button
              disabledReason={promote.disabledReason}
              onClick={promote.onSelect}
            >
              Promote…
            </Button>
          )
        }
        secondaryActions={
          distributionOn
            ? [rollBack, promote, pinOn, ...unyank]
            : [rollBack, pinOn, ...unyank]
        }
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
      {current === "status" ? (
        <StatusTab
          slug={slug}
          release={release}
          channels={appChannels}
          previous={previous}
          distributionOn={distributionOn}
          rows={rows}
          matrixLoading={distributionOn && matrix.isPending}
          matrixError={distributionOn ? matrix.error : null}
          onRetry={() => void matrix.refetch()}
        />
      ) : null}
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
      <HaltEverywhereDialog
        slug={slug}
        open={halting}
        version={v}
        previous={previous?.version ?? null}
        rows={rows ?? []}
        onClose={() => setHalting(false)}
      />
      <RollBackDialog
        open={rollingBack}
        release={release}
        previous={previous}
        channels={appChannels.map((c) => c.channel)}
        serving={serving}
        floors={store.data?.floors ?? []}
        onChoose={(next) => {
          setRollingBack(false);
          setAction(next);
        }}
        onClose={() => setRollingBack(false)}
      />
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
