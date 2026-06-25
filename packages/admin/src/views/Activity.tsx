import * as React from "react";
import { AlertTriangle, ScrollText } from "lucide-react";
import { api, type ActivityCursor, type ActivityItem } from "../api.js";
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  TooltipProvider,
  Tooltip,
  useKeysetPagination,
  type ColumnDef,
} from "../components/ui/index.js";
import { absoluteTime, relativeTime } from "./format.js";

/**
 * Product audit log. A keyset-paginated, append-as-you-go feed: the first page loads on mount
 * and "Load more" walks the `nextCursor` returned by `api.activity`. Times render relative with
 * the absolute timestamp in a tooltip. Loading/empty/error are all surfaced inline.
 */
export function Activity({ slug }: { slug: string }): React.ReactElement {
  const fetchPage = React.useCallback(
    (cursor: ActivityCursor | null) => api.activity(slug, cursor),
    [slug],
  );
  const { items, loading, error, hasMore, loadMore, reset } = useKeysetPagination<ActivityItem>(
    fetchPage,
    [slug],
  );

  // First page is "loading" only while we have nothing on screen yet.
  const firstLoad = loading && items.length === 0;

  const columns = React.useMemo<ColumnDef<ActivityItem>[]>(
    () => [
      {
        id: "at",
        header: "When",
        accessor: (r) => r.at,
        className: "whitespace-nowrap text-muted-foreground",
        cell: (r) => (
          <Tooltip content={absoluteTime(r.at)}>
            <time dateTime={new Date(r.at * 1000).toISOString()} tabIndex={0}>
              {relativeTime(r.at)}
            </time>
          </Tooltip>
        ),
      },
      {
        id: "actor",
        header: "Actor",
        accessor: (r) => r.actor.name || r.actor.email,
        cell: (r) => (
          <div className="min-w-0">
            <div className="truncate font-medium">{r.actor.name || r.actor.email || "—"}</div>
            {r.actor.name && r.actor.email ? (
              <div className="truncate text-xs text-muted-foreground">{r.actor.email}</div>
            ) : null}
          </div>
        ),
      },
      {
        id: "action",
        header: "Action",
        accessor: (r) => r.action,
        className: "whitespace-nowrap",
        cell: (r) => (
          <Badge variant="outline" className="font-mono text-[11px]">
            {r.action}
          </Badge>
        ),
      },
      {
        id: "target",
        header: "Target",
        accessor: (r) => (r.target ? `${r.target.kind}:${r.target.id}` : ""),
        className: "text-muted-foreground",
        cell: (r) =>
          r.target ? (
            <span className="font-mono text-xs">
              {r.target.kind}
              <span className="text-muted-foreground/60">/</span>
              {r.target.id}
            </span>
          ) : (
            <span aria-hidden>—</span>
          ),
      },
      {
        id: "summary",
        header: "Summary",
        accessor: (r) => r.summary,
        cell: (r) => r.summary,
      },
    ],
    [],
  );

  return (
    <TooltipProvider delayDuration={200}>
      <section aria-labelledby="activity-title" className="space-y-4">
        <header className="flex items-end justify-between gap-3">
          <div className="space-y-1">
            <h2 id="activity-title" className="text-xl font-semibold tracking-tight">
              Activity
            </h2>
            <p className="text-sm text-muted-foreground">
              The audit log of admin actions for <span className="font-medium text-foreground">{slug}</span>.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={reset} disabled={loading} aria-label="Refresh activity">
            Refresh
          </Button>
        </header>

        {error && items.length === 0 ? (
          <EmptyState
            icon={<AlertTriangle aria-hidden />}
            title="Couldn’t load activity"
            description={error}
            action={
              <Button variant="outline" size="sm" onClick={reset}>
                Try again
              </Button>
            }
          />
        ) : (
          <>
            <DataTable
              columns={columns}
              rows={items}
              rowKey={(r) => r.id}
              loading={firstLoad}
              empty={
                <EmptyState
                  icon={<ScrollText aria-hidden />}
                  title="No activity yet"
                  description="Admin actions on this product will appear here."
                  className="rounded-none border-0"
                />
              }
            />

            <div className="flex items-center justify-center gap-3" aria-live="polite">
              {error && items.length > 0 ? (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              ) : null}
              {hasMore ? (
                <Button variant="outline" size="sm" onClick={loadMore} loading={loading && items.length > 0}>
                  Load more
                </Button>
              ) : items.length > 0 ? (
                <p className="text-xs text-muted-foreground">End of log · {items.length} entries</p>
              ) : null}
            </div>
          </>
        )}
      </section>
    </TooltipProvider>
  );
}
