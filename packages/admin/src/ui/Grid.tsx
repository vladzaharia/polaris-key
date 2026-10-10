import * as React from "react";
import { cn } from "../lib/cn.js";

export interface GridProps<R, C> {
  /** The grid's accessible name ("Distribution matrix: releases by outlet"). */
  label: string;
  rows: R[];
  columns: C[];
  getRowId: (row: R) => string;
  getColumnId: (column: C) => string;
  rowHeader: (row: R) => React.ReactNode;
  columnHeader: (column: C) => React.ReactNode;
  /** The visible cell summary: a glyph plus a short label, at most one secondary line. */
  cell: (row: R, column: C) => React.ReactNode;
  /** The cell's accessible name: a full sentence ("2.4.0 on App Store: Live, rolling out 25 %"). */
  cellLabel: (row: R, column: C) => string;
  /** Enter, Space or a click: open the cell drawer. Actions never live in cells. */
  onCellActivate?: (row: R, column: C) => void;
  /** The name of the row-header column ("Release"). */
  cornerLabel?: string;
  stickyRowHeader?: boolean;
  stickyColumnHeader?: boolean;
  className?: string;
}

/**
 * The matrix primitive (components.md §6.14), shared by the Distribution matrix and the
 * Compatibility matrix. The WAI-ARIA grid pattern on a native table: one tab stop (roving
 * tabindex), arrow keys move, Home/End go to the row ends, Ctrl+Home/End to the corners, Enter
 * or Space activates. Leaving the grid and coming back returns to the last cell. Cells are
 * summaries; detail goes to a drawer, never to a `title` (MTX-1, MTX-3, CMP-2).
 */
export function Grid<R, C>({
  label,
  rows,
  columns,
  getRowId,
  getColumnId,
  rowHeader,
  columnHeader,
  cell,
  cellLabel,
  onCellActivate,
  cornerLabel = "Rows",
  stickyRowHeader = true,
  stickyColumnHeader = true,
  className,
}: GridProps<R, C>): React.ReactElement {
  const [active, setActive] = React.useState({ r: 0, c: 0 });
  const cells = React.useRef(new Map<string, HTMLTableCellElement>());
  const focusPending = React.useRef(false);

  const maxR = rows.length - 1;
  const maxC = columns.length - 1;
  const r = Math.min(active.r, Math.max(0, maxR));
  const c = Math.min(active.c, Math.max(0, maxC));

  React.useEffect(() => {
    if (!focusPending.current) return;
    focusPending.current = false;
    cells.current.get(`${r}:${c}`)?.focus();
  }, [r, c]);

  const moveTo = (nr: number, nc: number): void => {
    const next = {
      r: Math.max(0, Math.min(maxR, nr)),
      c: Math.max(0, Math.min(maxC, nc)),
    };
    if (next.r === r && next.c === c) {
      cells.current.get(`${r}:${c}`)?.focus();
      return;
    }
    focusPending.current = true;
    setActive(next);
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const ctrl = e.ctrlKey || e.metaKey;
    switch (e.key) {
      case "ArrowRight":
        moveTo(r, c + 1);
        break;
      case "ArrowLeft":
        moveTo(r, c - 1);
        break;
      case "ArrowDown":
        moveTo(r + 1, c);
        break;
      case "ArrowUp":
        moveTo(r - 1, c);
        break;
      case "Home":
        moveTo(ctrl ? 0 : r, 0);
        break;
      case "End":
        moveTo(ctrl ? maxR : r, maxC);
        break;
      case "PageDown":
        moveTo(r + 10, c);
        break;
      case "PageUp":
        moveTo(r - 10, c);
        break;
      case "Enter":
      case " ": {
        const row = rows[r];
        const col = columns[c];
        if (row !== undefined && col !== undefined) onCellActivate?.(row, col);
        break;
      }
      default:
        return;
    }
    e.preventDefault();
  };

  return (
    <div
      className={cn(
        "overflow-auto rounded-lg border border-border bg-surface-raised pk-scroll",
        className,
      )}
    >
      <table
        role="grid"
        aria-label={label}
        aria-rowcount={rows.length + 1}
        aria-colcount={columns.length + 1}
        onKeyDown={onKeyDown}
        className="w-full border-collapse text-sm"
      >
        <thead>
          <tr>
            <th
              scope="col"
              className={cn(
                "border-b border-border bg-surface-raised px-3 py-2 text-left text-xs font-medium text-fg-muted",
                stickyColumnHeader && "sticky top-0 z-[2]",
                stickyRowHeader && "sticky left-0 z-[3]",
              )}
            >
              {cornerLabel}
            </th>
            {columns.map((col) => (
              <th
                key={getColumnId(col)}
                scope="col"
                className={cn(
                  "border-b border-border bg-surface-raised px-3 py-2 text-left text-xs font-medium text-fg-muted",
                  stickyColumnHeader && "sticky top-0 z-[1]",
                )}
              >
                {columnHeader(col)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={getRowId(row)} className="border-b border-border">
              <th
                scope="row"
                className={cn(
                  "bg-surface-raised px-3 py-2 text-left align-middle font-normal text-fg",
                  stickyRowHeader && "sticky left-0 z-[1]",
                )}
              >
                {rowHeader(row)}
              </th>
              {columns.map((col, ci) => {
                const isActive = ri === r && ci === c;
                return (
                  <td
                    key={getColumnId(col)}
                    ref={(el) => {
                      const key = `${ri}:${ci}`;
                      if (el) cells.current.set(key, el);
                      else cells.current.delete(key);
                    }}
                    role="gridcell"
                    tabIndex={isActive ? 0 : -1}
                    aria-label={cellLabel(row, col)}
                    data-active={isActive || undefined}
                    onClick={() => {
                      setActive({ r: ri, c: ci });
                      onCellActivate?.(row, col);
                    }}
                    onFocus={() => {
                      if (!isActive) setActive({ r: ri, c: ci });
                    }}
                    className={cn(
                      "px-3 py-2 align-middle text-fg outline-hidden",
                      onCellActivate &&
                        "cursor-pointer hover:bg-surface-overlay",
                      "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus",
                    )}
                  >
                    <span aria-hidden>{cell(row, col)}</span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
