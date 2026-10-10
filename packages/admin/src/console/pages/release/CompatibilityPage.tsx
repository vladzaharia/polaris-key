import * as React from "react";
import { platformLabel } from "@polaris-key/manifest";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  CircleDot,
  ExternalLink,
  Pin,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type {
  CompatAppReleaseDto,
  CompatCellDto,
  CompatPackReleaseDto,
  CompatResponse,
  DistributionMatrix,
} from "../../../api.js";
import { cn } from "../../../lib/cn.js";
import { docsUrl } from "../../../lib/docsLinks.js";
import { formatDate, fromSeconds } from "../../../lib/format.js";
import { statusOf } from "../../../lib/status.js";
import { useLoadingAnnouncement } from "../../../ui/loading.js";
import { Button } from "../../../ui/Button.js";
import { Callout } from "../../../ui/Callout.js";
import { Checkbox } from "../../../ui/Checkbox.js";
import { Combobox } from "../../../ui/Combobox.js";
import { DescriptionList } from "../../../ui/DescriptionList.js";
import { Drawer, DrawerBody, DrawerFooter } from "../../../ui/Drawer.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { Grid } from "../../../ui/Grid.js";
import { Select } from "../../../ui/Select.js";
import { PageSkeleton } from "../../../ui/Skeleton.js";
import { StatusPill } from "../../../ui/StatusPill.js";
import { Version } from "../../../ui/Version.js";
import { EntityLink, entityHref } from "../../components/EntityLink.js";
import { PageHeader } from "../../../ui/PageHeader.js";
import { PageTabs } from "../../components/PageTabs.js";
import { useProduct } from "../../data/hooks.js";
import {
  Link,
  codecs,
  navigate,
  useLocation,
  useSearchParam,
} from "../../router.js";
import { r } from "../../routes.js";
import {
  COMPAT_PAGE,
  MATRIX_WINDOW,
  useCompat,
  useMatrixOverlay,
  useReleaseStore,
} from "./data.js";
import { APP } from "./shared.js";

/**
 * Release → Compatibility, the matrix (ADMIN.md §6.3.5, T5; CMP-1 to CMP-7, CMP-11): app releases
 * × pack releases on the `Grid` primitive (sticky axes, one tab stop, arrow keys), each cell a
 * glyph and a word, its reason and links in the cell drawer (`?cell=<app>:<pack release>`), never
 * a `title`. The per-outlet overlay reads Distribution's matrix through the shared query, so a
 * rollout or readiness write refreshes it (CMP-4).
 */

const STATE_ICON: Record<string, LucideIcon> = {
  pinned: Pin,
  compatible: CheckCircle2,
  held: AlertTriangle,
  incompatible: XCircle,
  revoked: Ban,
};

const STATE_CLASS: Record<string, string> = {
  pinned: "text-accent-fg",
  compatible: "text-success",
  held: "text-warning",
  incompatible: "text-fg-muted",
  revoked: "text-danger",
};

/** The tabs of the Compatibility page: the matrix and the simulator. */
export function CompatTabs({
  slug,
  value,
}: {
  slug: string;
  value: "matrix" | "simulator";
}): React.ReactElement {
  return (
    <PageTabs
      label="Compatibility"
      value={value}
      items={[
        { value: "matrix", label: "Matrix", to: r.compatibility(slug) },
        { value: "simulator", label: "Simulator", to: r.simulator(slug) },
      ]}
    />
  );
}

export function HowToRead(): React.ReactElement {
  return (
    <a
      href={docsUrl("compatSimulator")}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-sm text-accent-fg underline-offset-4 hover:underline"
    >
      How to read it
      <ExternalLink aria-hidden className="size-3.5" />
      <span className="sr-only">(opens the docs in a new tab)</span>
    </a>
  );
}

function Legend(): React.ReactElement {
  return (
    <ul
      aria-label="Legend"
      className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg"
    >
      {Object.keys(STATE_ICON).map((s) => {
        const Icon = STATE_ICON[s]!;
        return (
          <li key={s} className="inline-flex items-center gap-1">
            <Icon aria-hidden className={cn("size-3.5", STATE_CLASS[s])} />
            {statusOf("compat", s).label}
          </li>
        );
      })}
      <li className="inline-flex items-center gap-1">
        <CircleDot aria-hidden className="size-3.5 text-fg" />
        Current set member
      </li>
      <li className="inline-flex items-center gap-1">
        <span className="line-through">1.2.4</span> Yanked
      </li>
    </ul>
  );
}

/** Which outlets serve an app release, from Distribution's matrix; `unknown` past its window. */
function overlayOf(
  matrix: DistributionMatrix | undefined,
  releaseId: string,
): { live: string[]; held: string[]; unknown: boolean } {
  if (!matrix) return { live: [], held: [], unknown: false };
  if (!matrix.releases.some((x) => x.releaseId === releaseId))
    return { live: [], held: [], unknown: true };
  const cells = matrix.cells.filter((c) => c.releaseId === releaseId);
  return {
    live: cells.filter((c) => c.availability === "live").map((c) => c.outletId),
    held: cells.filter((c) => c.readiness?.holds).map((c) => c.outletId),
    unknown: false,
  };
}

function cellText(c: CompatCellDto | undefined): string {
  if (!c) return "No cell";
  return statusOf("compat", c.state).label;
}

function CellView({ c }: { c: CompatCellDto | undefined }): React.ReactElement {
  if (!c) return <span className="text-fg-subtle">—</span>;
  const Icon = STATE_ICON[c.state] ?? CircleDot;
  return (
    <span
      data-state={c.state}
      data-current={c.current ? "true" : "false"}
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-1.5 py-0.5 text-xs",
        c.current && "ring-2 ring-fg",
        c.yanked && "line-through",
      )}
    >
      <Icon className={cn("size-3.5", STATE_CLASS[c.state])} />
      {cellText(c)}
      {c.current ? <span className="font-medium">· Current</span> : null}
    </span>
  );
}

function RowHeader({
  slug,
  a,
  levels,
  overlay,
}: {
  slug: string;
  a: CompatAppReleaseDto;
  levels: ReadonlySet<number>;
  overlay: { live: string[]; held: string[]; unknown: boolean } | null;
}): React.ReactElement {
  return (
    <div className="min-w-44 space-y-0.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <EntityLink
          slug={slug}
          kind="release"
          id={a.releaseId}
          label={
            <span
              className={cn("font-mono text-xs", a.yanked && "line-through")}
            >
              {a.version}
            </span>
          }
        />
        {a.yanked ? <StatusPill tone="neutral">Yanked</StatusPill> : null}
        {a.channel ? (
          <span className="text-xs text-fg-muted">{a.channel}</span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-fg-muted">
        {a.contentApi !== null ? (
          <span
            className={
              a.live && levels.has(a.contentApi) ? "text-success" : undefined
            }
          >
            Content API {a.contentApi}
          </span>
        ) : (
          <span>No Content API</span>
        )}
        {a.live ? <span>· live on {a.liveOn.join(", ")}</span> : null}
        {a.unsatisfied.length ? (
          <span className="inline-flex items-center gap-0.5 text-warning">
            <AlertTriangle aria-hidden className="size-3" />
            {a.unsatisfied.length} unsatisfied
          </span>
        ) : null}
      </div>
      {overlay ? (
        <div className="text-xs text-fg-muted">
          {overlay.unknown
            ? `Not in the newest ${MATRIX_WINDOW} releases tracked by Distribution`
            : overlay.live.length || overlay.held.length
              ? [
                  overlay.live.length
                    ? `Outlets: ${overlay.live.join(", ")}`
                    : null,
                  overlay.held.length
                    ? `held on ${overlay.held.join(", ")}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : "On no outlet"}
        </div>
      ) : null}
    </div>
  );
}

function ColumnHeader({
  slug,
  p,
  pack,
}: {
  slug: string;
  p: CompatPackReleaseDto;
  pack: CompatResponse["packs"][number] | undefined;
}): React.ReactElement {
  return (
    <div className="min-w-24 space-y-0.5 font-normal">
      <div className="font-mono text-xs text-fg-strong">{p.pack}</div>
      <div className="flex flex-wrap items-center gap-1">
        <EntityLink
          slug={slug}
          kind="pack-release"
          deliverable={p.pack}
          id={p.releaseId}
          label={
            <span
              className={cn("font-mono text-xs", p.yanked && "line-through")}
            >
              {p.version}
            </span>
          }
        />
        {p.current ? (
          <span className="inline-flex items-center gap-0.5 text-xs text-fg">
            <CircleDot aria-hidden className="size-3" />
            Current
          </span>
        ) : null}
        {p.yanked ? (
          <span className="text-xs text-fg-muted">Yanked</span>
        ) : null}
        {p.revoked ? <StatusPill tone="danger">Revoked</StatusPill> : null}
      </div>
      {pack ? (
        <div className="text-xs text-fg-subtle">
          {pack.binding}
          {pack.required ? ", required" : ""}
        </div>
      ) : null}
    </div>
  );
}

function CellDrawer({
  slug,
  compat,
  cellKey,
  onClose,
}: {
  slug: string;
  compat: CompatResponse | undefined;
  cellKey: string;
  onClose: () => void;
}): React.ReactElement {
  const [appId, packId] = cellKey.split(":");
  const a = compat?.appReleases.find((x) => x.releaseId === appId);
  const p = compat?.packReleases.find((x) => x.releaseId === packId);
  const c = compat?.cells.find(
    (x) => x.appReleaseId === appId && x.packReleaseId === packId,
  );
  const open = !!cellKey && !!a && !!p;
  const unsatisfied = a?.unsatisfied.filter((u) => u.pack === p?.pack) ?? [];
  return (
    <Drawer
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={
        a && p ? (
          <span className="font-mono">
            {a.version} × {p.pack} {p.version}
          </span>
        ) : (
          "Cell"
        )
      }
      description="Why this app release does or doesn't run this pack release."
    >
      {a && p ? (
        <>
          <DrawerBody className="space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <CellView c={c} />
              {c?.yanked ? (
                <StatusPill tone="neutral">Yanked</StatusPill>
              ) : null}
            </div>
            {c?.reason ? <p className="text-sm text-fg">{c.reason}</p> : null}
            <DescriptionList
              items={[
                {
                  term: "Pack release requires",
                  detail:
                    [
                      p.requires.contentApi.length
                        ? `contentApi ${p.requires.contentApi.join(", ")}`
                        : "no contentApi requirement",
                      p.requires.engines.length
                        ? `engine ${p.requires.engines.join(", ")}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join("; ") || "—",
                },
                {
                  term: "App release",
                  detail: [
                    a.contentApi !== null
                      ? `contentApi ${a.contentApi}`
                      : "no contentApi",
                    a.engines.length ? `engines ${a.engines.join(", ")}` : null,
                    a.platforms.length
                      ? a.platforms.map((x) => platformLabel(x)).join(", ")
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · "),
                },
                ...(p.yanked
                  ? [
                      {
                        term: "Pack release yanked",
                        detail: `${p.yanked.reason} (${formatDate(fromSeconds(p.yanked.at))})`,
                      },
                    ]
                  : []),
                ...(p.revoked
                  ? [
                      {
                        term: "Revoked",
                        detail: `${p.revoked.reason}${p.revoked.replacement ? "" : " · no replacement"}`,
                      },
                    ]
                  : []),
              ]}
            />
            {unsatisfied.length ? (
              <section className="space-y-1.5">
                <h3 className="text-sm font-semibold text-fg-strong">
                  Unsatisfied requirements
                </h3>
                <ul className="list-disc space-y-1 pl-5 text-sm">
                  {unsatisfied.map((u, i) => (
                    <li key={i}>
                      {platformLabel(u.platform)}
                      {u.variant ? ` · ${u.variant}` : ""} on {u.channel}:{" "}
                      {u.reason}, {u.detail}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </DrawerBody>
          <DrawerFooter className="sm:justify-start">
            <Button asChild variant="outline" size="sm">
              <Link
                to={entityHref(slug, {
                  kind: "pack-release",
                  deliverable: p.pack,
                  id: p.releaseId,
                })}
              >
                Open pack release
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to={r.release(slug, a.releaseId)}>Open app release</Link>
            </Button>
            <Button asChild size="sm">
              <Link
                to={r.simulator(slug, {
                  app: a.releaseId,
                  platform: a.platforms[0],
                  ...(a.channel ? { channel: a.channel } : {}),
                })}
              >
                Simulate this device
              </Link>
            </Button>
          </DrawerFooter>
        </>
      ) : null}
    </Drawer>
  );
}

export function CompatibilityPage({
  slug,
}: {
  slug: string;
}): React.ReactElement {
  const [offset, setOffset] = useSearchParam("offset", codecs.int(0));
  const [packFilter, setPackFilter] = useSearchParam("pack", codecs.string());
  const [channel, setChannel] = useSearchParam("channel", codecs.string());
  const [liveOnly, setLiveOnly] = useSearchParam(
    "live",
    codecs.oneOf(["", "1"], ""),
  );
  const [cell, setCell] = useSearchParam("cell", codecs.string());
  const { hash } = useLocation();
  /** Several query keys in one write (sequential setters would each start from the old hash). */
  const setQuery = (changes: Record<string, string | null>): void => {
    const i = hash.indexOf("?");
    const path = i === -1 ? hash : hash.slice(0, i);
    const q = new URLSearchParams(i === -1 ? "" : hash.slice(i + 1));
    for (const [k, v] of Object.entries(changes)) {
      if (v === null || v === "") q.delete(k);
      else q.set(k, v);
    }
    const s = q.toString();
    navigate(`${path || r.compatibility(slug)}${s ? `?${s}` : ""}`, {
      replace: true,
    });
  };
  const [focus, setFocus] = React.useState<string | null>(null);
  const product = useProduct(slug);
  const distributionOn =
    product.data?.services?.distribution?.enabled !== false;
  const compat = useCompat(slug, offset);
  const overlay = useMatrixOverlay(slug, distributionOn);
  const store = useReleaseStore(slug);
  useLoadingAnnouncement("compatibility matrix", compat.isPending);

  const data = compat.data;
  const header = (
    <PageHeader
      title="Compatibility"
      meta={<HowToRead />}
      tabs={<CompatTabs slug={slug} value="matrix" />}
      refetching={compat.isFetching && !compat.isPending}
    />
  );

  if (compat.isPending)
    return (
      <div className="space-y-6">
        {header}
        <PageSkeleton template="matrix" label="the compatibility matrix" />
      </div>
    );
  if (compat.error && !data)
    return (
      <div className="space-y-6">
        {header}
        <ErrorState
          error={compat.error}
          onRetry={() => void compat.refetch()}
        />
      </div>
    );
  if (!data) return header;

  const levels = new Set(data.levels);
  const rows = data.appReleases.filter(
    (a) => (!channel || a.channel === channel) && (liveOnly !== "1" || a.live),
  );
  const cols = data.packReleases.filter(
    (p) => !packFilter || p.pack === packFilter,
  );
  const cellOf = new Map(
    data.cells.map((c) => [`${c.appReleaseId}\u0000${c.packReleaseId}`, c]),
  );
  const packOf = new Map(data.packs.map((p) => [p.id, p]));
  const filtered = !!channel || liveOnly === "1" || !!packFilter;
  const appTotal =
    data.offset + data.appReleases.length + data.older.appReleases;
  const hasOlder = data.older.appReleases > 0 || data.older.packReleases > 0;

  const appReleases = (store.data?.releases ?? []).filter(
    (x) => x.deliverable === APP,
  );
  const jump = (releaseId: string | null): void => {
    if (!releaseId) return;
    const target = appReleases.find((x) => x.releaseId === releaseId);
    if (!target) return;
    const sameChannel = appReleases
      .filter((x) => x.channel === target.channel)
      .sort((x, y) => (y.seq ?? 0) - (x.seq ?? 0));
    const idx = sameChannel.findIndex((x) => x.releaseId === releaseId);
    const page = Math.floor(Math.max(0, idx) / COMPAT_PAGE) * COMPAT_PAGE;
    setQuery({
      channel: null,
      live: null,
      offset: page ? String(page) : null,
    });
    setFocus(releaseId);
  };

  return (
    <div className="space-y-4" data-template="matrix">
      {header}
      {data.appReleases.length === 0 && data.offset === 0 ? (
        <EmptyState
          kind="first-run"
          title="No app releases yet"
          description="The matrix fills in once an app release with content is published."
          docs={docsUrl("compatSimulator")}
        />
      ) : data.packs.length === 0 ? (
        <EmptyState
          kind="first-run"
          title="No packs declared"
          description="Compatibility compares app releases with pack releases. Declare a pack in .pkey/release to see which app releases run which pack releases."
          docs={docsUrl("packDeliverables")}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <span id="compat-pack" className="text-xs text-fg-muted">
                Packs
              </span>
              <Select
                aria-labelledby="compat-pack"
                options={data.packs.map((p) => ({ value: p.id, label: p.id }))}
                allowEmpty
                emptyLabel="All packs"
                value={packFilter || null}
                onChange={(v) => setPackFilter(v ?? "")}
              />
            </div>
            <div className="space-y-1">
              <span id="compat-channel" className="text-xs text-fg-muted">
                Channel
              </span>
              <Select
                aria-labelledby="compat-channel"
                options={data.channels.map((c) => ({ value: c, label: c }))}
                allowEmpty
                emptyLabel="Any channel"
                value={channel || null}
                onChange={(v) => setChannel(v ?? "")}
              />
            </div>
            <div className="flex h-9 items-center self-end">
              <Checkbox
                checked={liveOnly === "1"}
                onCheckedChange={(v) => setLiveOnly(v ? "1" : "")}
                label="Live only"
              />
            </div>
            <div className="space-y-1">
              <span id="compat-jump" className="text-xs text-fg-muted">
                Jump to a version
              </span>
              <Combobox
                aria-labelledby="compat-jump"
                value={null}
                onChange={jump}
                options={appReleases.map((x) => ({
                  value: x.releaseId,
                  label: x.version,
                  secondary: x.channel ?? undefined,
                }))}
                placeholder="Version"
                searchPlaceholder="Search versions"
                emptyText="No version matches."
              />
            </div>
          </div>
          <Legend />
          {Object.keys(data.liveLevels).length ? (
            <p
              className="text-xs text-fg-muted"
              aria-label="Live contentApi levels"
            >
              Live Content API levels:{" "}
              {Object.entries(data.liveLevels)
                .map(([c, ls]) => `${c} ${ls.join(", ")}`)
                .join(" · ")}
            </p>
          ) : null}
          {data.capped ? (
            <Callout tone="info">
              Showing the newest 200 app releases; older ones are on later
              pages.
            </Callout>
          ) : null}
          {distributionOn && overlay.error ? (
            <Callout tone="warning" title="Outlet liveness unavailable">
              Distribution did not answer, so the rows don't say which outlets
              serve each release.
            </Callout>
          ) : null}
          {focus &&
          !rows.some((a) => a.releaseId === focus) &&
          !compat.isFetching ? (
            <Callout tone="info">
              That release is not on this page of its channel. Page older or
              newer to find it.
            </Callout>
          ) : null}
          {rows.length === 0 || cols.length === 0 ? (
            <EmptyState
              kind="no-results"
              title="No releases match these filters"
              filters={[
                packFilter ? `pack: ${packFilter}` : null,
                channel ? `channel: ${channel}` : null,
                liveOnly === "1" ? "live only" : null,
              ]
                .filter(Boolean)
                .join(", ")}
              onClearFilters={
                filtered
                  ? () => setQuery({ pack: null, channel: null, live: null })
                  : undefined
              }
            />
          ) : (
            <Grid<CompatAppReleaseDto, CompatPackReleaseDto>
              label="Compatibility: app releases by pack release"
              cornerLabel="App release"
              rows={rows}
              columns={cols}
              getRowId={(a) => a.releaseId}
              getColumnId={(p) => p.releaseId}
              rowHeader={(a) => (
                <div
                  className={cn(
                    focus === a.releaseId && "rounded-sm bg-accent-subtle",
                  )}
                >
                  <RowHeader
                    slug={slug}
                    a={a}
                    levels={levels}
                    overlay={
                      distributionOn
                        ? overlayOf(overlay.data, a.releaseId)
                        : null
                    }
                  />
                </div>
              )}
              columnHeader={(p) => (
                <ColumnHeader slug={slug} p={p} pack={packOf.get(p.pack)} />
              )}
              cell={(a, p) => (
                <CellView
                  c={cellOf.get(`${a.releaseId}\u0000${p.releaseId}`)}
                />
              )}
              cellLabel={(a, p) => {
                const c = cellOf.get(`${a.releaseId}\u0000${p.releaseId}`);
                return `${a.version} with ${p.pack} ${p.version}: ${cellText(c)}${c?.current ? ", the current set member" : ""}${c?.yanked ? ", yanked" : ""}.`;
              }}
              onCellActivate={(a, p) =>
                setCell(`${a.releaseId}:${p.releaseId}`)
              }
            />
          )}
          {/* Paging sits under the matrix, where the reader ends up. */}
          <nav
            aria-label="Compatibility pages"
            className="flex flex-wrap items-center justify-end gap-2 text-sm text-fg-muted"
          >
            <span aria-live="polite" className="mr-auto">
              Live app releases, then {data.offset + 1}–
              {data.offset + data.limit} of each channel ({appTotal} in all)
            </span>
            <Button
              variant="outline"
              size="sm"
              disabledReason={
                data.offset === 0 ? "These are the newest releases." : undefined
              }
              onClick={() => setOffset(Math.max(0, data.offset - COMPAT_PAGE))}
            >
              ‹ Newer
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabledReason={
                hasOlder ? undefined : "There are no older releases."
              }
              onClick={() => setOffset(data.offset + COMPAT_PAGE)}
            >
              Older ›
            </Button>
          </nav>
        </>
      )}
      <CellDrawer
        slug={slug}
        compat={data}
        cellKey={cell}
        onClose={() => setCell("")}
      />
    </div>
  );
}
