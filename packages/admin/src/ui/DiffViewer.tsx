import * as React from "react";
import { Minus, Pencil, Plus, TriangleAlert } from "lucide-react";
import { cn } from "../lib/cn.js";
import {
  diffSummary,
  lineDiff,
  structuredDiff,
  type EntryChange,
  type LineRow,
  type StructuredDiff,
} from "../lib/diff.js";

/**
 * Before/after comparison (components.md §6.8).
 *
 * - `structured`: changes grouped by entry: Added (success), Removed (danger, plus a "breaking"
 *   warning listing what still references the key), Changed (field-level before → after), under a
 *   summary header ("+2 keys · −1 key · 3 changed").
 * - `text`: a unified (or split) line diff of two strings, for JSON and YAML drafts and resync
 *   previews.
 *
 * Every row carries a text prefix ("Added", "Removed", "Changed"); colour is never alone.
 */

export interface StructuredDiffViewerProps<T extends object> {
  mode: "structured";
  before: readonly T[];
  after: readonly T[];
  /** The identity field (or function) entries are matched by. */
  entryKey: keyof T | ((entry: T) => string);
  /** A precomputed model (overrides `before`/`after`). */
  structure?: StructuredDiff<T>;
  /** Removed keys still referenced, mapped to who references them ("profile base-pro"). */
  referencedBy?: Record<string, readonly string[]>;
  /** The entry noun for the summary ("key"). */
  noun?: string;
  className?: string;
}

export interface TextDiffViewerProps {
  mode: "text";
  before: string;
  after: string;
  /** Unified (default) or side by side. */
  view?: "unified" | "split";
  /** Names the diff for assistive tech ("catalog JSON"). */
  label?: string;
  className?: string;
}

export type DiffViewerProps<T extends object> =
  | StructuredDiffViewerProps<T>
  | TextDiffViewerProps;

export function DiffViewer<T extends object>(
  props: DiffViewerProps<T>,
): React.ReactElement {
  return props.mode === "structured" ? (
    <StructuredView {...props} />
  ) : (
    <TextView {...props} />
  );
}

function show(v: unknown): string {
  if (v === undefined) return "—";
  if (typeof v === "string") return `"${v}"`;
  return JSON.stringify(v);
}

const KIND = {
  added: {
    label: "Added",
    icon: Plus,
    row: "border-success-border bg-success-subtle",
    fg: "text-success",
  },
  removed: {
    label: "Removed",
    icon: Minus,
    row: "border-danger-border bg-danger-subtle",
    fg: "text-danger",
  },
  changed: {
    label: "Changed",
    icon: Pencil,
    row: "border-border bg-surface-raised",
    fg: "text-info",
  },
} as const;

function StructuredView<T extends object>({
  before,
  after,
  entryKey,
  structure,
  referencedBy = {},
  noun = "key",
  className,
}: StructuredDiffViewerProps<T>): React.ReactElement {
  const model = React.useMemo(
    () => structure ?? structuredDiff(before, after, entryKey),
    [structure, before, after, entryKey],
  );
  const breaking = model.removed.filter((r) => referencedBy[r.key]?.length);
  return (
    <div className={cn("space-y-3", className)}>
      <p className="text-sm font-medium text-fg-strong">
        {diffSummary(model, noun)}
        {breaking.length ? (
          <span className="ml-2 inline-flex items-center gap-1 font-normal text-danger">
            <TriangleAlert aria-hidden className="size-4" />
            {breaking.length} breaking
          </span>
        ) : null}
      </p>
      {model.all.length === 0 ? (
        <p className="text-sm text-fg-muted">The two versions are identical.</p>
      ) : (
        <ul className="space-y-2" aria-label="Changes">
          {model.all.map((c) => (
            <ChangeRow
              key={`${c.kind}:${c.key}`}
              change={c}
              refs={referencedBy[c.key]}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ChangeRow<T>({
  change,
  refs,
}: {
  change: EntryChange<T>;
  refs?: readonly string[];
}): React.ReactElement {
  const k = KIND[change.kind];
  const Icon = k.icon;
  return (
    <li className={cn("rounded-md border px-3 py-2 text-sm", k.row)}>
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn("inline-flex items-center gap-1 font-medium", k.fg)}
        >
          <Icon aria-hidden className="size-4" />
          {k.label}
        </span>
        <code className="font-mono text-xs text-fg-strong">{change.key}</code>
        {change.kind === "removed" && refs?.length ? (
          <span className="inline-flex items-center gap-1 text-xs text-danger">
            <TriangleAlert aria-hidden className="size-3.5" />
            Breaking: referenced by {refs.join(", ")}
          </span>
        ) : null}
      </div>
      {change.kind === "changed" ? (
        <dl className="mt-1 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
          {change.fields.map((f) => (
            <React.Fragment key={f.field}>
              <dt className="font-mono text-fg-muted">{f.field}</dt>
              <dd className="min-w-0 break-words font-mono text-fg">
                <span className="text-fg-muted line-through">
                  <span className="sr-only">was </span>
                  {show(f.before)}
                </span>
                <span aria-hidden className="mx-1 text-fg-subtle">
                  →
                </span>
                <span className="sr-only"> now </span>
                <span className="text-fg-strong">{show(f.after)}</span>
              </dd>
            </React.Fragment>
          ))}
        </dl>
      ) : null}
    </li>
  );
}

const LINE = {
  added: { sign: "+", label: "Added", cls: "bg-success-subtle text-fg-strong" },
  removed: {
    sign: "−",
    label: "Removed",
    cls: "bg-danger-subtle text-fg-strong",
  },
  context: { sign: " ", label: "Unchanged", cls: "text-fg" },
} as const;

function LineCell({ row }: { row?: LineRow }): React.ReactElement {
  if (!row) return <span className="block min-h-5 bg-surface-sunken" />;
  const l = LINE[row.kind];
  return (
    <span className={cn("flex min-h-5", l.cls)}>
      <span
        aria-hidden
        className="w-5 shrink-0 select-none text-center text-fg-muted"
      >
        {l.sign}
      </span>
      {row.kind !== "context" ? (
        <span className="sr-only">{l.label}: </span>
      ) : null}
      <span className="whitespace-pre-wrap break-all">{row.text}</span>
    </span>
  );
}

function TextView({
  before,
  after,
  view: initialView = "unified",
  label = "Text diff",
  className,
}: TextDiffViewerProps): React.ReactElement {
  const [view, setView] = React.useState(initialView);
  const rows = React.useMemo(() => lineDiff(before, after), [before, after]);
  const added = rows.filter((r) => r.kind === "added").length;
  const removed = rows.filter((r) => r.kind === "removed").length;

  // Split view pairs each removed run with the added run that follows it.
  const pairs = React.useMemo(() => {
    const out: [LineRow | undefined, LineRow | undefined][] = [];
    let i = 0;
    while (i < rows.length) {
      const r = rows[i]!;
      if (r.kind === "context") {
        out.push([r, r]);
        i++;
        continue;
      }
      const rem: LineRow[] = [];
      const add: LineRow[] = [];
      while (rows[i]?.kind === "removed") rem.push(rows[i++]!);
      while (rows[i]?.kind === "added") add.push(rows[i++]!);
      for (let j = 0; j < Math.max(rem.length, add.length); j++)
        out.push([rem[j], add[j]]);
    }
    return out;
  }, [rows]);

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-border bg-surface-sunken",
        className,
      )}
    >
      <div className="flex items-center gap-3 border-b border-border px-3 py-1 text-xs">
        <span className="flex-1 text-fg-muted">
          {label}: <span className="text-success">+{added}</span>{" "}
          <span className="text-danger">−{removed}</span>
          <span className="sr-only">
            , {added} lines added, {removed} lines removed
          </span>
        </span>
        <div role="group" aria-label="Diff layout" className="flex gap-1">
          {(["unified", "split"] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => setView(v)}
              className={cn(
                "h-7 rounded-md px-2 capitalize text-fg-muted hover:bg-hover hover:text-fg-strong",
                view === v && "bg-hover font-medium text-fg-strong",
              )}
            >
              {v}
            </button>
          ))}
        </div>
      </div>
      <div
        tabIndex={0}
        role="region"
        aria-label={label}
        className="pk-scroll overflow-x-auto py-1 font-mono text-xs leading-5"
      >
        {view === "unified" ? (
          rows.map((r, i) => <LineCell key={i} row={r} />)
        ) : (
          <div className="grid grid-cols-2 divide-x divide-border">
            <div>
              <span className="sr-only">Before</span>
              {pairs.map(([b], i) => (
                <LineCell key={i} row={b} />
              ))}
            </div>
            <div>
              <span className="sr-only">After</span>
              {pairs.map(([, a], i) => (
                <LineCell key={i} row={a} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
