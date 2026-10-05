/**
 * Distribution → Matrix (ADMIN.md §6.4, T5). "Where is each release, and what is it doing there?"
 * Fixes MTX-1 to MTX-10.
 *
 * - Cells are summaries (a status plus at most one secondary line); every action lives in the
 *   cell drawer (MTX-1). The `Grid` primitive gives one tab stop, arrow keys and Enter.
 * - The view (Availability, Rollouts, Readiness) changes only the cell summary (MTX-2); the
 *   deliverable picker covers packs and the row limit is the server's 20 or 50 (MTX-6). All of it,
 *   and the open cell, is in the URL.
 * - The response is indexed into a `Map` once (MTX-8). Empty states split by cause (MTX-9).
 * - Below 768 px the grid becomes a card per release; "View as grid" keeps the grid reachable.
 */

import * as React from "react";
import { Grid3x3, Plus, RefreshCw } from "lucide-react";
import type {
  DistributionMatrix,
  MatrixCellDto,
  MatrixRolloutDto,
} from "../../../api.js";
import { docsUrl } from "../../../lib/docsLinks.js";
import { formatCount, fromSeconds } from "../../../lib/format.js";
import { statusOf } from "../../../lib/status.js";
import { Button } from "../../../ui/Button.js";
import { Callout } from "../../../ui/Callout.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { Grid } from "../../../ui/Grid.js";
import { SegmentedControl } from "../../../ui/SegmentedControl.js";
import { Select } from "../../../ui/Select.js";
import { Skeleton } from "../../../ui/Skeleton.js";
import { StatusPill } from "../../../ui/StatusPill.js";
import { Timestamp } from "../../../ui/Timestamp.js";
import { toast } from "../../../ui/toast.js";
import { useMediaQuery } from "../../../ui/data-table/DataTable.js";
import { PageHeader } from "../../components/PageHeader.js";
import { mutate } from "../../data/mutations.js";
import { useSearchParam } from "../../router.js";
import { CellDrawer } from "./CellDrawer.js";
import {
  MATRIX_LIMITS,
  patchQuery,
  QUERY,
  useDeliverables,
  useMatrix,
  type MatrixView,
} from "./data.js";
import { outletKindLabel, READINESS_LABEL, rolloutSummary } from "./format.js";
import { StartRolloutDialog } from "./RolloutDialogs.js";

type Release = DistributionMatrix["releases"][number];
type Outlet = DistributionMatrix["outlets"][number];

const VIEW_OPTIONS: { value: MatrixView; label: string }[] = [
  { value: "availability", label: "Availability" },
  { value: "rollouts", label: "Rollouts" },
  { value: "readiness", label: "Readiness" },
];

const ANY_CHANNEL = "__any__";

/** `releaseId:outletId` (the `cell` query parameter; a release id may hold a colon). */
export function cellKey(releaseId: string, outletId: string): string {
  return `${releaseId}:${outletId}`;
}

export function parseCell(
  raw: string,
): { releaseId: string; outletId: string } | null {
  const i = raw.lastIndexOf(":");
  if (i <= 0 || i === raw.length - 1) return null;
  return { releaseId: raw.slice(0, i), outletId: raw.slice(i + 1) };
}

/** The response, indexed once (MTX-8). */
export function indexCells(
  matrix: DistributionMatrix,
): Map<string, MatrixCellDto> {
  const map = new Map<string, MatrixCellDto>();
  for (const c of matrix.cells) map.set(cellKey(c.releaseId, c.outletId), c);
  return map;
}

/** The rollout a cell's summary shows: an active one first, then the most recently changed. */
function leadRollout(cell: MatrixCellDto): MatrixRolloutDto | undefined {
  return (
    cell.rollouts.find((r) => r.state === "active") ??
    [...cell.rollouts].sort((a, b) => b.updatedAt - a.updatedAt)[0]
  );
}

interface Summary {
  pill: React.ReactNode;
  secondary?: string;
  /** For the accessible sentence. */
  words: string;
}

function availabilitySummary(cell: MatrixCellDto | undefined): Summary {
  if (!cell || !cell.availability) {
    return {
      pill: (
        <StatusPill tone="neutral" icon={null} size="sm">
          Not available
        </StatusPill>
      ),
      words: "not available",
    };
  }
  const entry = statusOf("availability", cell.availability);
  const lead = leadRollout(cell);
  const held = cell.readiness?.holds === true;
  const secondary = held
    ? "Held for packs"
    : lead && lead.state !== "complete"
      ? rolloutSummary(lead)
      : undefined;
  return {
    pill: (
      <StatusPill domain="availability" state={cell.availability} size="sm" />
    ),
    secondary,
    words: [entry.label, secondary].filter(Boolean).join(", "),
  };
}

function rolloutsSummary(cell: MatrixCellDto | undefined): Summary {
  const lead = cell ? leadRollout(cell) : undefined;
  if (!cell || !lead) {
    return {
      pill: <span className="text-fg-subtle">—</span>,
      words: "no rollout",
    };
  }
  const more = cell.rollouts.length - 1;
  const secondary = [
    lead.channel,
    lead.mirrored ? "store-owned" : null,
    more > 0 ? `+${more} more` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    pill: (
      <StatusPill domain="rollout" state={lead.state} size="sm">
        {rolloutSummary(lead)}
      </StatusPill>
    ),
    secondary,
    words: `${rolloutSummary(lead)} on ${lead.channel}${lead.mirrored ? ", owned by the store" : ""}`,
  };
}

function readinessSummary(cell: MatrixCellDto | undefined): Summary {
  const r = cell?.readiness;
  if (!r) {
    return {
      pill: <span className="text-fg-subtle">—</span>,
      words: "readiness not tracked",
    };
  }
  const n = r.blockers.length;
  if (r.holds) {
    const text = `Held · ${n} ${n === 1 ? "blocker" : "blockers"}`;
    return {
      pill: (
        <StatusPill tone="warning" size="sm">
          {text}
        </StatusPill>
      ),
      words: text,
    };
  }
  if (r.state === "ready" || r.state === "overridden") {
    const text = READINESS_LABEL[r.state] ?? "Ready";
    return {
      pill: (
        <StatusPill tone="success" size="sm">
          {text}
        </StatusPill>
      ),
      words: text,
    };
  }
  const text = r.warning
    ? "Not ready · store can't be held"
    : (READINESS_LABEL[r.state] ?? r.state);
  return {
    pill: (
      <StatusPill
        tone={r.state === "pending" ? "neutral" : "warning"}
        size="sm"
      >
        {r.state === "pending" ? "Pending" : "Not ready"}
      </StatusPill>
    ),
    words: text,
  };
}

function summaryFor(
  view: MatrixView,
  cell: MatrixCellDto | undefined,
): Summary {
  if (view === "rollouts") return rolloutsSummary(cell);
  if (view === "readiness") return readinessSummary(cell);
  return availabilitySummary(cell);
}

function CellSummary({ s }: { s: Summary }): React.ReactElement {
  return (
    <span className="flex min-w-[8.5rem] flex-col items-start gap-0.5">
      {s.pill}
      {s.secondary ? (
        <span className="text-xs text-fg-muted">{s.secondary}</span>
      ) : null}
    </span>
  );
}

function ReleaseHeader({
  release,
  now,
}: {
  release: Release;
  now?: number;
}): React.ReactElement {
  return (
    <span className="flex min-w-[9rem] flex-col gap-0.5 text-left">
      <span className="flex flex-wrap items-center gap-1.5">
        <span
          className={
            release.yanked
              ? "font-mono text-xs text-fg-muted line-through"
              : "font-mono text-xs text-fg-strong"
          }
        >
          {release.version}
        </span>
        {release.yanked ? (
          <StatusPill tone="neutral" size="sm">
            Yanked
          </StatusPill>
        ) : null}
      </span>
      <span className="text-xs font-normal text-fg-muted">
        {release.channel ?? "no channel"}
        {release.publishedAt !== null ? (
          <>
            {" · "}
            <Timestamp at={fromSeconds(release.publishedAt)} now={now} />
          </>
        ) : null}
      </span>
    </span>
  );
}

function OutletHeader({ outlet }: { outlet: Outlet }): React.ReactElement {
  return (
    <span className="flex min-w-[8.5rem] flex-col gap-0.5 text-left">
      <span className="text-sm font-bold text-fg-strong">
        {outlet.outletId}
      </span>
      <span className="text-xs font-normal text-fg-muted">
        {outletKindLabel(outlet.kind)}
        {outlet.derives ? " · self-hosted" : ""}
      </span>
      {!outlet.supported ? (
        <span className="text-xs font-normal text-warning">
          {outlet.transport}: not delivered by Polaris Key
        </span>
      ) : null}
    </span>
  );
}

const LEGEND: { node: React.ReactNode; key: string }[] = [
  {
    key: "live",
    node: <StatusPill domain="availability" state="live" size="sm" />,
  },
  {
    key: "review",
    node: <StatusPill domain="availability" state="in-review" size="sm" />,
  },
  {
    key: "na",
    node: (
      <StatusPill tone="neutral" icon={null} size="sm">
        Not available
      </StatusPill>
    ),
  },
  {
    key: "held",
    node: (
      <StatusPill tone="warning" size="sm">
        Held
      </StatusPill>
    ),
  },
  {
    key: "rejected",
    node: <StatusPill domain="availability" state="rejected" size="sm" />,
  },
  {
    key: "pending",
    node: <StatusPill domain="availability" state="pending" size="sm" />,
  },
  {
    key: "ready",
    node: (
      <StatusPill tone="success" size="sm">
        Ready
      </StatusPill>
    ),
  },
  {
    key: "rolling",
    node: <StatusPill domain="rollout" state="active" size="sm" />,
  },
  {
    key: "halted",
    node: <StatusPill domain="rollout" state="halted" size="sm" />,
  },
];

/** Each view's cells use their own words, so the legend follows the view. */
const LEGEND_KEYS: Record<MatrixView, string[]> = {
  availability: ["live", "review", "pending", "na", "held", "rejected"],
  readiness: ["ready", "held", "pending"],
  rollouts: ["rolling", "halted", "pending"],
};

export function MatrixPage({ slug }: { slug: string }): React.ReactElement {
  const [deliverable] = useSearchParam("deliverable", QUERY.deliverable);
  const [view, setView] = useSearchParam("view", QUERY.view);
  const [limit] = useSearchParam("limit", QUERY.limit);
  const [channel] = useSearchParam("channel", QUERY.channel);
  const [cell] = useSearchParam("cell", QUERY.cell);
  const narrow = useMediaQuery("(max-width: 767px)");
  const [forceGrid, setForceGrid] = React.useState(false);
  const [starting, setStarting] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [refreshed, setRefreshed] = React.useState<number | null>(null);

  const matrix = useMatrix(slug, deliverable, limit);
  const deliverables = useDeliverables(slug);
  const data = matrix.data;
  const cells = React.useMemo(
    () => (data ? indexCells(data) : new Map<string, MatrixCellDto>()),
    [data],
  );

  const rows = React.useMemo(
    () =>
      (data?.releases ?? []).filter(
        (r) => channel === "" || r.channel === channel,
      ),
    [data, channel],
  );
  const channels = React.useMemo(
    () =>
      [...new Set((data?.releases ?? []).map((r) => r.channel))]
        .filter((c): c is string => !!c)
        .sort(),
    [data],
  );

  const deliverableOptions = React.useMemo(() => {
    const list = (deliverables.data?.deliverables ?? []).map((d) => ({
      value: d.id,
      label: d.id === "app" ? "App" : d.id,
      description: d.kind === "pack" ? "Pack" : "The app",
    }));
    if (!list.some((o) => o.value === deliverable))
      list.unshift({
        value: deliverable,
        label: deliverable === "app" ? "App" : deliverable,
        description: deliverable === "app" ? "The app" : "Pack",
      });
    return list;
  }, [deliverables.data, deliverable]);

  const deliverableName =
    deliverable === "app" ? "the app" : `the ${deliverable} pack`;

  const openCell = (releaseId: string, outletId: string): void =>
    patchQuery({ cell: cellKey(releaseId, outletId) }, { push: true });
  const closeCell = (): void => patchQuery({ cell: null });

  const refreshReadiness = async (): Promise<void> => {
    setRefreshing(true);
    try {
      const result = await mutate("refreshReadiness", slug);
      setRefreshed(result?.refreshed ?? 0);
    } catch (err) {
      toast.error(err, { context: { area: "distribution" } });
    } finally {
      setRefreshing(false);
    }
  };

  const capped = data ? data.releases.length >= data.limit : false;
  const open = parseCell(cell);

  return (
    <div className="space-y-5" data-template="matrix">
      <PageHeader
        title="Matrix"
        meta={
          <>
            <a
              className="text-accent-fg underline-offset-4 hover:underline"
              href={docsUrl("rolloutControl")}
              target="_blank"
              rel="noreferrer"
            >
              How rollouts reach devices
            </a>
          </>
        }
        primaryAction={
          <Button
            iconStart={<Plus aria-hidden />}
            onClick={() => setStarting(true)}
          >
            Start rollout…
          </Button>
        }
        secondaryActions={
          deliverable === "app"
            ? [
                {
                  label: refreshing
                    ? "Refreshing readiness…"
                    : "Refresh readiness",
                  icon: <RefreshCw aria-hidden />,
                  onSelect: () => void refreshReadiness(),
                  disabledReason: refreshing
                    ? "Readiness is being recomputed."
                    : undefined,
                },
              ]
            : []
        }
        refetching={matrix.isFetching && !matrix.isPending}
      />

      {refreshed !== null ? (
        <Callout
          tone="success"
          title="Readiness recomputed"
          live
          action={
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setRefreshed(null)}
            >
              Dismiss
            </Button>
          }
        >
          {refreshed === 0
            ? "Nothing changed: every release's readiness was already current."
            : `${formatCount(refreshed)} release × outlet ${refreshed === 1 ? "pair was" : "pairs were"} recomputed. Holds follow the new answer.`}
        </Callout>
      ) : null}

      <div
        role="toolbar"
        aria-label="Matrix options"
        className="flex flex-wrap items-end gap-3"
      >
        <label className="flex flex-col gap-1 text-xs font-bold text-fg-muted">
          Deliverable
          <Select
            aria-label="Deliverable"
            className="w-44"
            value={deliverable}
            options={deliverableOptions}
            onChange={(v) =>
              patchQuery({
                deliverable: v === "app" ? null : v,
                cell: null,
                channel: null,
              })
            }
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-bold text-fg-muted">
          Channel
          <Select
            aria-label="Channel"
            className="w-36"
            value={channel === "" ? ANY_CHANNEL : channel}
            options={[
              { value: ANY_CHANNEL, label: "Any channel" },
              ...channels.map((c) => ({ value: c, label: c })),
            ]}
            onChange={(v) =>
              patchQuery({ channel: v === ANY_CHANNEL ? null : v })
            }
          />
        </label>
        <div className="flex flex-col gap-1">
          <span
            id="matrix-view-label"
            className="text-xs font-bold text-fg-muted"
          >
            View
          </span>
          <SegmentedControl
            aria-labelledby="matrix-view-label"
            options={VIEW_OPTIONS}
            value={view}
            onChange={setView}
          />
        </div>
        <label className="flex flex-col gap-1 text-xs font-bold text-fg-muted">
          Rows
          <Select
            aria-label="Rows"
            className="w-24"
            value={String(limit)}
            options={MATRIX_LIMITS.map((n) => ({
              value: String(n),
              label: String(n),
            }))}
            onChange={(v) =>
              patchQuery({ limit: v === String(MATRIX_LIMITS[0]) ? null : v })
            }
          />
        </label>
      </div>

      <ul
        aria-label="Legend"
        className="flex flex-wrap items-center gap-2 text-xs text-fg-muted"
      >
        {LEGEND.filter((l) =>
          (LEGEND_KEYS[view] ?? LEGEND_KEYS.availability).includes(l.key),
        ).map((l) => (
          <li key={l.key}>{l.node}</li>
        ))}
      </ul>

      {matrix.isPending ? (
        <div
          className="space-y-2"
          aria-busy="true"
          aria-label="Loading the matrix"
        >
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : matrix.isError && !data ? (
        <ErrorState
          error={matrix.error}
          onRetry={() => void matrix.refetch()}
          context={{ area: "distribution", thing: "Deliverable" }}
        />
      ) : !data || data.releases.length === 0 ? (
        <EmptyState
          kind="first-run"
          headingLevel={2}
          title={`No releases of ${deliverableName} yet`}
          description="A release appears here once CI publishes one. Each outlet then reports where it is live."
          docs="/docs/services/release/"
        />
      ) : data.outlets.length === 0 ? (
        <EmptyState
          kind="first-run"
          headingLevel={2}
          title="No outlets declared"
          description="Outlets are the places a release reaches: Polaris Key downloads, the stores, the storefront feeds. Declare them in .pkey/distribution and resync."
          docs="/docs/services/distribution/"
        />
      ) : rows.length === 0 ? (
        <EmptyState
          kind="no-results"
          headingLevel={2}
          title="No releases on this channel"
          filters={`channel: ${channel}`}
          onClearFilters={() => patchQuery({ channel: null })}
        />
      ) : narrow && !forceGrid ? (
        <ReleaseCards
          rows={rows}
          outlets={data.outlets}
          cells={cells}
          view={view}
          onOpen={openCell}
          onGrid={() => setForceGrid(true)}
        />
      ) : (
        <div className="rounded-lg border border-border bg-surface-raised">
          <Grid<Release, Outlet>
            label={`Distribution matrix of ${deliverableName}: releases by outlet`}
            rows={rows}
            columns={data.outlets}
            getRowId={(r) => r.releaseId}
            getColumnId={(o) => o.outletId}
            cornerLabel="Release"
            rowHeader={(r) => <ReleaseHeader release={r} />}
            columnHeader={(o) => <OutletHeader outlet={o} />}
            cell={(r, o) => (
              <CellSummary
                s={summaryFor(
                  view,
                  cells.get(cellKey(r.releaseId, o.outletId)),
                )}
              />
            )}
            cellLabel={(r, o) =>
              `${r.version} on ${o.outletId}: ${summaryFor(view, cells.get(cellKey(r.releaseId, o.outletId))).words}. Open details.`
            }
            onCellActivate={(r, o) => openCell(r.releaseId, o.outletId)}
          />
        </div>
      )}

      {data && capped ? (
        <p className="text-sm text-fg-muted" role="note">
          Showing the newest {data.limit} releases.
          {data.limit < MATRIX_LIMITS[1] ? (
            <>
              {" "}
              <Button
                variant="link"
                size="sm"
                onClick={() => patchQuery({ limit: String(MATRIX_LIMITS[1]) })}
              >
                Show {MATRIX_LIMITS[1]}
              </Button>
            </>
          ) : null}
        </p>
      ) : null}

      {data ? (
        <CellDrawer
          slug={slug}
          matrix={data}
          cell={
            open ? cells.get(cellKey(open.releaseId, open.outletId)) : undefined
          }
          target={open}
          onClose={closeCell}
        />
      ) : null}

      <StartRolloutDialog
        slug={slug}
        open={starting}
        initial={{ deliverable }}
        onClose={() => setStarting(false)}
      />
    </div>
  );
}

/** Below 768 px: one card per release, its outlets as rows (T5 responsive rule). */
function ReleaseCards({
  rows,
  outlets,
  cells,
  view,
  onOpen,
  onGrid,
}: {
  rows: Release[];
  outlets: Outlet[];
  cells: Map<string, MatrixCellDto>;
  view: MatrixView;
  onOpen: (releaseId: string, outletId: string) => void;
  onGrid: () => void;
}): React.ReactElement {
  return (
    <div className="space-y-3">
      <Button
        variant="outline"
        size="sm"
        iconStart={<Grid3x3 aria-hidden />}
        onClick={onGrid}
      >
        View as grid
      </Button>
      <ul className="space-y-3" aria-label="Releases">
        {rows.map((r) => (
          <li
            key={r.releaseId}
            className="rounded-lg border border-border bg-surface-raised"
          >
            <div className="border-b border-border px-4 py-3">
              <ReleaseHeader release={r} />
            </div>
            <ul className="divide-y divide-border">
              {outlets.map((o) => {
                const s = summaryFor(
                  view,
                  cells.get(cellKey(r.releaseId, o.outletId)),
                );
                return (
                  <li
                    key={o.outletId}
                    className="flex items-center justify-between gap-3 px-4 py-2"
                  >
                    <span className="min-w-0">
                      <span className="block text-sm font-bold text-fg-strong">
                        {o.outletId}
                      </span>
                      <CellSummary s={s} />
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Details of ${r.version} on ${o.outletId}`}
                      onClick={() => onOpen(r.releaseId, o.outletId)}
                    >
                      Details
                    </Button>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}
