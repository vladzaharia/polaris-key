/**
 * Distribution → Rollouts (ADMIN.md §6.4, T2): every rollout, live, with its controls. Fixes
 * DOV-1 to DOV-4: no hard-coded caveat, linked releases with who changed them and when, an inline
 * error with Retry, and no developer internals (the descriptor hooks card is gone; the
 * Release → Distribution → Update chain is shown on Core → Services).
 *
 * UX-31 (EXPERIENCE.md §0.2, C7): Rollouts is the one home of the matrix too. Three views, as
 * route tabs in the URL (`?view=`): **List** (this table), **Matrix** (the release × outlet grid's
 * availability) and **Readiness** (the same grid's readiness). Whole rows open the rollout: its
 * cell drawer, over the list, with every control (EXPERIENCE.md §6).
 *
 * Halted rows sort first. Facets: state and outlet, in the URL.
 */

import * as React from "react";
import { Plus, RefreshCw } from "lucide-react";
import type { Rollout } from "../../../../api.js";
import { Button } from "../../../../ui/Button.js";
import { PageHeader } from "../../../../ui/PageHeader.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { useWriteGate } from "../../../access/useCan.js";
import { PageTabs } from "../../../components/PageTabs.js";
import { useSearchParam } from "../../../router.js";
import { codecs } from "../../../routes.js";
import { CollectionTemplate } from "../../../templates/Collection.js";
import { CellDrawer } from "../components/CellDrawer.js";
import { RolloutList } from "../components/RolloutList.js";
import { StartRolloutDialog } from "../components/RolloutDialogs.js";
import {
  hrefWithQuery,
  patchQuery,
  QUERY,
  useMatrix,
  useRollouts,
} from "../data.js";
import {
  cellKey,
  indexCells,
  MatrixBoard,
  parseCell,
  ReadinessRefreshed,
  ROLLOUT_VIEWS,
  useReadinessRefresh,
  type RolloutsView,
} from "./MatrixPage.js";

/** Module-level, so `useSearchParam` keeps one codec identity. */
const VIEW = codecs.oneOf(ROLLOUT_VIEWS, "list");

const VIEW_TABS: { value: RolloutsView; label: string }[] = [
  { value: "list", label: "List" },
  { value: "matrix", label: "Matrix" },
  { value: "readiness", label: "Readiness" },
];

/** The rollout's own place: its cell drawer, opened over the page the row is on. */
function rolloutHref(r: Rollout): string {
  return hrefWithQuery({
    cell: cellKey(r.releaseId, r.outletId),
    deliverable: r.deliverableId === "app" ? null : r.deliverableId,
  });
}

export function RolloutsPage({ slug }: { slug: string }): React.ReactElement {
  const [view] = useSearchParam("view", VIEW);
  const [deliverable] = useSearchParam("deliverable", QUERY.deliverable);
  const [cell] = useSearchParam("cell", QUERY.cell);
  const readiness = useReadinessRefresh(slug);
  const gate = useWriteGate("ship", slug);
  const rollouts = useRollouts(slug);
  const [starting, setStarting] = React.useState(false);

  const rows = rollouts.data?.rollouts ?? [];
  const halted = rows.filter((r) => r.state === "halted").length;

  const grid = view !== "list";
  const tabs = (
    <PageTabs
      label="Rollouts views"
      value={view}
      items={VIEW_TABS.map((t) => ({
        ...t,
        // Switching view closes an open drawer; the grid's options and the table's state stay.
        to: hrefWithQuery({
          view: t.value === "list" ? null : t.value,
          cell: null,
        }),
      }))}
    />
  );

  return (
    <CollectionTemplate
      header={
        <PageHeader
          title="Rollouts"
          titleAside={
            rollouts.data && rows.length > 0 ? (
              <span className="inline-flex items-center gap-2">
                <span className="text-sm tabular-nums text-fg-muted">
                  {rows.length}
                </span>
                {halted > 0 ? (
                  <StatusPill tone="danger" size="sm">
                    {halted} halted
                  </StatusPill>
                ) : null}
              </span>
            ) : undefined
          }
          primaryAction={
            <Button
              iconStart={<Plus aria-hidden />}
              disabledReason={gate.disabledReason}
              onClick={() => setStarting(true)}
            >
              Start rollout…
            </Button>
          }
          secondaryActions={
            grid && deliverable === "app"
              ? [
                  {
                    label: readiness.refreshing
                      ? "Refreshing readiness…"
                      : "Refresh readiness",
                    icon: <RefreshCw aria-hidden />,
                    onSelect: () => void readiness.run(),
                    disabledReason: readiness.refreshing
                      ? "Readiness is being recomputed."
                      : undefined,
                  },
                ]
              : []
          }
          tabs={tabs}
          refetching={rollouts.isFetching && !rollouts.isPending}
        />
      }
    >
      <div className="pk-vt-tabpanel">
        <p className="mb-4 text-sm text-fg-muted">
          A halt or pause reaches devices on their next feed check.
        </p>
        {grid ? (
          <>
            <ReadinessRefreshed
              refreshed={readiness.refreshed}
              onDismiss={readiness.dismiss}
            />
            <MatrixBoard
              slug={slug}
              view={view === "readiness" ? "readiness" : "availability"}
            />
          </>
        ) : (
          <RolloutList
            slug={slug}
            rollouts={rollouts}
            tableId="rollouts"
            hrefFor={rolloutHref}
            starting={starting}
            onStartingChange={setStarting}
            startInitial={{ deliverable: "app" }}
          />
        )}
      </div>
      {!grid && cell !== "" ? (
        <ListCellDrawer slug={slug} cell={cell} deliverable={deliverable} />
      ) : null}
      {grid ? (
        <StartRolloutDialog
          slug={slug}
          open={starting}
          initial={{ deliverable }}
          onClose={() => setStarting(false)}
        />
      ) : null}
    </CollectionTemplate>
  );
}

/**
 * The open rollout's drawer over the list view: the matrix cell of its release and outlet, with
 * every control the cell has. Mounted only while a row is open, so the list costs no matrix read.
 */
function ListCellDrawer({
  slug,
  cell,
  deliverable,
}: {
  slug: string;
  cell: string;
  deliverable: string;
}): React.ReactElement | null {
  const [limit] = useSearchParam("limit", QUERY.limit);
  const matrix = useMatrix(slug, deliverable, limit);
  const cells = React.useMemo(
    () => (matrix.data ? indexCells(matrix.data) : null),
    [matrix.data],
  );
  const target = parseCell(cell);
  if (!matrix.data || !cells) return null;
  return (
    <CellDrawer
      slug={slug}
      matrix={matrix.data}
      cell={
        target
          ? cells.get(cellKey(target.releaseId, target.outletId))
          : undefined
      }
      target={target}
      onClose={() => patchQuery({ cell: null, deliverable: null })}
    />
  );
}
