import * as React from "react";
import { Table2, BarChart3 } from "lucide-react";
import { cn } from "../../lib/cn.js";

/**
 * The "Show as table" half of every chart (components.md §6.13, the dataviz rule that a table
 * view always exists): a figure with a caption, the chart, and a toggle to a real `<table>` of
 * the same numbers.
 */
export interface ChartTableData {
  columns: string[];
  /** One row per datum; cells are already formatted text. */
  rows: (string | number)[][];
}

export function ChartTable({
  caption,
  columns,
  rows,
  className,
}: ChartTableData & {
  caption: string;
  className?: string;
}): React.ReactElement {
  return (
    <div className={cn("overflow-x-auto", className)}>
      <table className="w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-border">
            {columns.map((c, i) => (
              <th
                key={c}
                scope="col"
                className={cn(
                  "px-2 py-1 text-xs font-bold text-fg-muted",
                  i === 0 ? "text-left" : "text-right",
                )}
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r} className="border-b border-border last:border-0">
              {row.map((cell, i) =>
                i === 0 ? (
                  <th
                    key={i}
                    scope="row"
                    className="px-2 py-1 text-left font-normal text-fg"
                  >
                    {cell}
                  </th>
                ) : (
                  <td
                    key={i}
                    className="px-2 py-1 text-right tabular-nums text-fg"
                  >
                    {cell}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A chart figure: caption, chart or table, and the toggle between them. */
export function ChartFrame({
  title,
  description,
  table,
  children,
  className,
  titleHidden = false,
}: {
  title: string;
  description?: React.ReactNode;
  /** The caption is read by AT only: a heading right above already shows it. */
  titleHidden?: boolean;
  table: ChartTableData;
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  const [asTable, setAsTable] = React.useState(false);
  return (
    <figure className={cn("space-y-3", className)}>
      <div className="flex items-start gap-2">
        <figcaption className="min-w-0 flex-1">
          <span
            className={
              titleHidden ? "sr-only" : "block text-sm font-bold text-fg-strong"
            }
          >
            {title}
          </span>
          {description ? (
            <span className="block text-xs text-fg-muted">{description}</span>
          ) : null}
        </figcaption>
        <button
          type="button"
          aria-pressed={asTable}
          onClick={() => setAsTable((v) => !v)}
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs text-fg-muted hover:bg-hover hover:text-fg-strong"
        >
          {asTable ? (
            <BarChart3 aria-hidden className="size-3.5" />
          ) : (
            <Table2 aria-hidden className="size-3.5" />
          )}
          {asTable ? "Show as chart" : "Show as table"}
        </button>
      </div>
      {asTable ? <ChartTable caption={title} {...table} /> : children}
    </figure>
  );
}
