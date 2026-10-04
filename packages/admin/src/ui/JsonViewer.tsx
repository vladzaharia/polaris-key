import * as React from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "../lib/cn.js";
import { announce } from "./LiveRegion.js";
import { ValueCopyButton } from "./IdChip.js";

/**
 * A collapsible JSON tree (components.md §6.7), keyboard navigable as a WAI-ARIA `tree`: one tab
 * stop, ↑/↓ move, → expands or enters, ← collapses or goes to the parent, Home/End, Enter or Space
 * toggles. On the focused node, `c` copies its value and `p` copies its path (the per-row copy
 * buttons do the same for a pointer). Arrays and objects longer than 100 children show the first
 * 100 and a "Show 100 more" row.
 */

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export interface JsonViewerProps {
  value: unknown;
  /** Names the tree for assistive tech ("Trust set"). */
  label: string;
  /** Depth expanded initially (default 2; the root is depth 0). */
  collapsedDepth?: number;
  /** A copy-the-whole-document button above the tree (default true). */
  copy?: boolean;
  className?: string;
}

const PAGE = 100;

interface Node {
  id: string;
  path: string;
  keyLabel: string | null;
  value: Json;
  depth: number;
  parent: string | null;
}

function isContainer(v: Json): v is Json[] | { [k: string]: Json } {
  return v !== null && typeof v === "object";
}

function childPath(parent: string, key: string | number): string {
  if (typeof key === "number") return `${parent}[${key}]`;
  const safe = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? key
    : JSON.stringify(key);
  if (parent === "") return safe.startsWith('"') ? `[${safe}]` : safe;
  return safe.startsWith('"') ? `${parent}[${safe}]` : `${parent}.${safe}`;
}

function entriesOf(v: Json): [string | number, Json][] {
  if (Array.isArray(v)) return v.map((x, i) => [i, x]);
  if (isContainer(v)) return Object.entries(v);
  return [];
}

function summary(v: Json): string {
  if (Array.isArray(v))
    return `[${v.length} ${v.length === 1 ? "item" : "items"}]`;
  if (isContainer(v)) {
    const n = Object.keys(v).length;
    return `{${n} ${n === 1 ? "key" : "keys"}}`;
  }
  return JSON.stringify(v);
}

function valueClass(v: Json): string {
  if (typeof v === "string") return "text-success";
  if (typeof v === "number") return "text-warning";
  if (typeof v === "boolean" || v === null) return "text-info";
  return "text-fg-muted";
}

export function JsonViewer({
  value,
  label,
  collapsedDepth = 2,
  copy = true,
  className,
}: JsonViewerProps): React.ReactElement {
  const root = value as Json;
  const [expanded, setExpanded] = React.useState<Set<string>>(() => {
    const open = new Set<string>();
    const walk = (v: Json, path: string, depth: number): void => {
      if (!isContainer(v) || depth >= collapsedDepth) return;
      open.add(path);
      for (const [k, c] of entriesOf(v).slice(0, PAGE))
        walk(c, childPath(path, k), depth + 1);
    };
    walk(root, "", 0);
    return open;
  });
  const [limits, setLimits] = React.useState<Record<string, number>>({});
  const [focused, setFocused] = React.useState<string>("");
  const refs = React.useRef(new Map<string, HTMLLIElement>());
  const hintId = React.useId();

  // The visible rows, in order: what the arrow keys walk.
  const visible = React.useMemo(() => {
    const rows: (
      | Node
      | {
          id: string;
          more: string;
          depth: number;
          parent: string;
          remaining: number;
        }
    )[] = [];
    const walk = (
      v: Json,
      path: string,
      keyLabel: string | null,
      depth: number,
      parent: string | null,
    ): void => {
      rows.push({ id: path, path, keyLabel, value: v, depth, parent });
      if (!isContainer(v) || !expanded.has(path)) return;
      const all = entriesOf(v);
      const limit = limits[path] ?? PAGE;
      for (const [k, c] of all.slice(0, limit))
        walk(c, childPath(path, k), String(k), depth + 1, path);
      if (all.length > limit) {
        rows.push({
          id: `${path}\u0000more`,
          more: path,
          depth: depth + 1,
          parent: path,
          remaining: all.length - limit,
        });
      }
    };
    walk(root, "", null, 0, null);
    return rows;
  }, [root, expanded, limits]);

  const activeId = visible.some((r) => r.id === focused) ? focused : "";

  const focusRow = (id: string): void => {
    setFocused(id);
    refs.current.get(id)?.focus();
  };

  const toggle = (path: string, open?: boolean): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      const want = open ?? !next.has(path);
      if (want) next.add(path);
      else next.delete(path);
      return next;
    });
  };

  const copyText = async (text: string, what: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      announce(`${what} copied`);
    } catch {
      announce("Press ⌘C to copy");
    }
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    // The row the key was pressed on (the focused treeitem), falling back to the roving stop.
    const target = (e.target as HTMLElement).closest<HTMLElement>(
      '[role="treeitem"]',
    );
    const fromTarget = target?.dataset.nodeId;
    const current = fromTarget ?? activeId;
    const i = visible.findIndex((r) => r.id === current);
    const row = visible[i];
    if (!row) return;
    const isMore = "more" in row;
    const node = isMore ? null : (row as Node);
    const container = node ? isContainer(node.value) : false;
    const open = node ? expanded.has(node.path) : false;
    switch (e.key) {
      case "ArrowDown":
        if (visible[i + 1]) focusRow(visible[i + 1]!.id);
        break;
      case "ArrowUp":
        if (visible[i - 1]) focusRow(visible[i - 1]!.id);
        break;
      case "Home":
        focusRow(visible[0]!.id);
        break;
      case "End":
        focusRow(visible[visible.length - 1]!.id);
        break;
      case "ArrowRight":
        if (node && container && !open) toggle(node.path, true);
        else if (node && container && open && visible[i + 1])
          focusRow(visible[i + 1]!.id);
        break;
      case "ArrowLeft":
        if (node && container && open) toggle(node.path, false);
        else if (row.parent !== null && row.parent !== undefined)
          focusRow(row.parent);
        break;
      case "Enter":
      case " ":
        if (isMore) {
          const path = (row as { more: string }).more;
          setLimits((l) => ({ ...l, [path]: (l[path] ?? PAGE) + PAGE }));
        } else if (node && container) toggle(node.path);
        break;
      case "c":
        if (node) void copyText(JSON.stringify(node.value, null, 2), "Value");
        break;
      case "p":
        if (node) void copyText(node.path || "$", "Path");
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const renderRows = (parent: string | null): React.ReactNode[] =>
    visible
      .filter((r) => r.parent === parent)
      .map((row) => {
        const tabIndex = row.id === activeId ? 0 : -1;
        if ("more" in row) {
          return (
            <li
              key={row.id}
              role="treeitem"
              data-node-id={row.id}
              aria-level={row.depth + 1}
              tabIndex={tabIndex}
              ref={(el) => {
                if (el) refs.current.set(row.id, el);
              }}
              onFocus={() => setFocused(row.id)}
              onClick={() =>
                setLimits((l) => ({
                  ...l,
                  [row.more]: (l[row.more] ?? PAGE) + PAGE,
                }))
              }
              className="cursor-pointer rounded-sm py-0.5 pl-6 text-accent-fg hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus"
            >
              Show {Math.min(PAGE, row.remaining)} more ({row.remaining} hidden)
            </li>
          );
        }
        const node = row as Node;
        const container = isContainer(node.value);
        const open = expanded.has(node.path);
        return (
          <li
            key={node.id}
            role="treeitem"
            data-node-id={node.id}
            aria-level={node.depth + 1}
            aria-expanded={container ? open : undefined}
            aria-label={`${node.keyLabel ?? "root"}: ${summary(node.value)}`}
            tabIndex={tabIndex}
            ref={(el) => {
              if (el) refs.current.set(node.id, el);
            }}
            onFocus={(e) => {
              if (e.target === e.currentTarget) setFocused(node.id);
            }}
            className="rounded-sm focus-visible:outline-hidden focus-visible:[&>div]:ring-2 focus-visible:[&>div]:ring-focus"
          >
            <div
              className="group flex items-center gap-1 rounded-sm py-0.5 pr-1 hover:bg-hover"
              onClick={() => {
                focusRow(node.id);
                if (container) toggle(node.path);
              }}
            >
              <span aria-hidden className="inline-flex w-4 justify-center">
                {container ? (
                  <ChevronRight
                    className={cn(
                      "size-3.5 text-fg-subtle transition-transform duration-(--pk-duration-fast)",
                      open && "rotate-90",
                    )}
                  />
                ) : null}
              </span>
              {node.keyLabel !== null ? (
                <span className="text-accent-fg">{node.keyLabel}</span>
              ) : (
                <span className="text-fg-muted">root</span>
              )}
              <span aria-hidden className="text-fg-subtle">
                :
              </span>
              <span className={cn("min-w-0 truncate", valueClass(node.value))}>
                {container && open
                  ? Array.isArray(node.value)
                    ? "["
                    : "{"
                  : summary(node.value)}
              </span>
              <span className="ml-auto hidden gap-1 group-hover:flex">
                <button
                  type="button"
                  tabIndex={-1}
                  aria-hidden
                  onClick={(e) => {
                    e.stopPropagation();
                    void copyText(node.path || "$", "Path");
                  }}
                  className="rounded-xs px-1 font-sans text-xs text-fg-muted hover:text-fg-strong"
                >
                  Copy path
                </button>
                <button
                  type="button"
                  tabIndex={-1}
                  aria-hidden
                  onClick={(e) => {
                    e.stopPropagation();
                    void copyText(JSON.stringify(node.value, null, 2), "Value");
                  }}
                  className="rounded-xs px-1 font-sans text-xs text-fg-muted hover:text-fg-strong"
                >
                  Copy value
                </button>
              </span>
            </div>
            {container && open ? (
              <ul role="group" className="ml-3 border-l border-border pl-2">
                {renderRows(node.path)}
              </ul>
            ) : null}
          </li>
        );
      });

  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-surface-sunken",
        className,
      )}
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-1">
        <span className="flex-1 text-xs text-fg-muted" id={hintId}>
          {label}. Arrow keys move and expand; c copies a value, p copies its
          path.
        </span>
        {copy ? (
          <ValueCopyButton
            value={JSON.stringify(root, null, 2)}
            label={`Copy ${label}`}
          />
        ) : null}
      </div>
      <ul
        role="tree"
        aria-label={label}
        aria-describedby={hintId}
        onKeyDown={onKeyDown}
        className="pk-scroll overflow-x-auto p-2 font-mono text-xs"
      >
        {renderRows(null)}
      </ul>
    </div>
  );
}
