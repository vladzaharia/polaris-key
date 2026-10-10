import * as React from "react";
import {
  observeElementRect,
  useVirtualizer,
  type Virtualizer,
} from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight, File, Folder } from "lucide-react";
import type { PackFileDto } from "../../../../api.js";
import { formatBytes, formatCount } from "../../../../lib/format.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { Hash } from "../../../../ui/Hash.js";
import { Input } from "../../../../ui/Input.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { usePackFiles } from "../data.js";

/**
 * One pack variant's files (ADMIN.md §6.3.4, PKD-7): a searchable path tree, virtualized past a
 * few hundred rows, read through the query cache (an index never changes for a published
 * release) with a Retry on failure. The server returns at most 2,000 entries and says how many the
 * index lists, so a capped list says so.
 */

const VIRTUAL_ABOVE = 200;
const ROW = 32;

interface DirRow {
  kind: "dir";
  path: string;
  name: string;
  depth: number;
  files: number;
}
interface FileRow {
  kind: "file";
  path: string;
  name: string;
  depth: number;
  file: PackFileDto;
}
type Row = DirRow | FileRow;

interface Dir {
  dirs: Map<string, Dir>;
  files: PackFileDto[];
  count: number;
}

function buildTree(files: PackFileDto[]): Dir {
  const root: Dir = { dirs: new Map(), files: [], count: 0 };
  for (const f of files) {
    const parts = f.path.split("/").filter(Boolean);
    let at = root;
    at.count++;
    for (const part of parts.slice(0, -1)) {
      let next = at.dirs.get(part);
      if (!next) {
        next = { dirs: new Map(), files: [], count: 0 };
        at.dirs.set(part, next);
      }
      next.count++;
      at = next;
    }
    at.files.push(f);
  }
  return root;
}

/** The rows a tree shows with `open` directories expanded. */
export function flattenTree(
  files: PackFileDto[],
  open: ReadonlySet<string>,
): Row[] {
  const out: Row[] = [];
  const walk = (dir: Dir, prefix: string, depth: number): void => {
    for (const [name, sub] of [...dir.dirs].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const path = prefix ? `${prefix}/${name}` : name;
      out.push({ kind: "dir", path, name, depth, files: sub.count });
      if (open.has(path)) walk(sub, path, depth + 1);
    }
    for (const f of [...dir.files].sort((a, b) =>
      a.path.localeCompare(b.path),
    )) {
      out.push({
        kind: "file",
        path: f.path,
        name: f.path.split("/").pop() ?? f.path,
        depth,
        file: f,
      });
    }
  };
  walk(buildTree(files), "", 0);
  return out;
}

function FileLine({
  row,
  open,
  onToggle,
  search,
}: {
  row: Row;
  open: boolean;
  onToggle: (path: string) => void;
  search: boolean;
}): React.ReactElement {
  if (row.kind === "dir") {
    return (
      <button
        type="button"
        aria-expanded={open}
        onClick={() => onToggle(row.path)}
        className="flex h-8 w-full items-center gap-1.5 rounded-sm px-2 text-left text-sm text-fg hover:bg-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus"
      >
        <span className="inline-flex items-center gap-1.5">
          {open ? (
            <ChevronDown aria-hidden className="size-3.5 text-fg-muted" />
          ) : (
            <ChevronRight aria-hidden className="size-3.5 text-fg-muted" />
          )}
          <Folder aria-hidden className="size-3.5 text-fg-muted" />
        </span>
        <span className="font-mono text-xs">{row.name}/</span>
        <span className="text-xs text-fg-muted">
          {formatCount(row.files)} {row.files === 1 ? "file" : "files"}
        </span>
      </button>
    );
  }
  const f = row.file;
  return (
    <div className="flex h-8 items-center gap-3 px-2 text-xs">
      <File aria-hidden className="size-3.5 shrink-0 text-fg-muted" />
      <span className="min-w-0 flex-1 truncate font-mono">
        {search ? row.path : row.name}
      </span>
      <span className="tabular-nums text-fg-muted">{formatBytes(f.size)}</span>
      {f.blob.codec !== "none" ? (
        <span className="hidden text-fg-muted sm:inline">
          {f.blob.codec} {formatBytes(f.blob.bytes)}
        </span>
      ) : null}
      <Hash
        value={f.sha256}
        label="SHA-256"
        className="hidden md:inline-flex"
      />
    </div>
  );
}

export function PackFileBrowser({
  slug,
  deliverable,
  releaseId,
  variant,
}: {
  slug: string;
  deliverable: string;
  releaseId: string;
  variant: string;
}): React.ReactElement {
  const query = usePackFiles(slug, { deliverable, releaseId, variant });
  const [q, setQ] = React.useState("");
  const [open, setOpen] = React.useState<ReadonlySet<string>>(new Set());
  const files = query.data?.files ?? [];
  const term = q.trim().toLowerCase();
  const rows: Row[] = React.useMemo(
    () =>
      term
        ? files
            .filter((f) => f.path.toLowerCase().includes(term))
            .map((f) => ({
              kind: "file" as const,
              path: f.path,
              name: f.path,
              depth: 0,
              file: f,
            }))
        : flattenTree(files, open),
    [files, open, term],
  );
  const toggle = (path: string): void =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const virtual = rows.length > VIRTUAL_ABOVE;
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: virtual ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW,
    overscan: 12,
    initialRect: { width: 640, height: 320 },
    observeElementRect: (
      instance: Virtualizer<HTMLDivElement, HTMLDivElement>,
      cb,
    ) =>
      observeElementRect(instance, (rect) =>
        cb(rect.height > 0 ? rect : { width: rect.width || 640, height: 320 }),
      ),
  });

  if (query.isPending) return <Skeleton className="h-24 w-full" />;
  if (query.error)
    return (
      <ErrorState
        error={query.error}
        onRetry={() => void query.refetch()}
        compact
      />
    );
  const total = query.data?.total ?? 0;
  const label = `Files of ${variant || "the default variant"}`;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Input
          aria-label="Search files"
          placeholder="Search paths"
          value={q}
          onValueChange={setQ}
          clearable
          className="max-w-72"
        />
        <p className="text-xs text-fg-muted" aria-live="polite">
          {term
            ? `${formatCount(rows.length)} of ${formatCount(files.length)} files match`
            : total === files.length
              ? `${formatCount(total)} files`
              : `The first ${formatCount(files.length)} of ${formatCount(total)} files`}
        </p>
      </div>
      <div
        ref={scrollRef}
        role="group"
        aria-label={label}
        className="pk-scroll max-h-80 overflow-y-auto rounded-md border border-border"
      >
        {rows.length === 0 ? (
          <p className="p-3 text-xs text-fg-muted">
            {term ? "No path matches." : "This variant lists no files."}
          </p>
        ) : virtual ? (
          <div
            className="relative w-full"
            data-height={virtualizer.getTotalSize()}
            ref={(el) => {
              if (el) el.style.height = `${virtualizer.getTotalSize()}px`;
            }}
          >
            {virtualizer.getVirtualItems().map((v) => {
              const row = rows[v.index]!;
              return (
                <div
                  key={row.path}
                  className="absolute inset-x-0"
                  ref={(el) => {
                    if (el) el.style.transform = `translateY(${v.start}px)`;
                  }}
                >
                  <Indented row={row} search={!!term}>
                    <FileLine
                      row={row}
                      open={open.has(row.path)}
                      onToggle={toggle}
                      search={!!term}
                    />
                  </Indented>
                </div>
              );
            })}
          </div>
        ) : (
          <ul>
            {rows.map((row) => (
              <li key={row.path}>
                <Indented row={row} search={!!term}>
                  <FileLine
                    row={row}
                    open={open.has(row.path)}
                    onToggle={toggle}
                    search={!!term}
                  />
                </Indented>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Indentation through CSSOM (the CSP forbids inline `style` attributes in markup). */
function Indented({
  row,
  search,
  children,
}: {
  row: Row;
  search: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  const depth = search ? 0 : row.depth;
  return (
    <div
      data-depth={depth}
      ref={(el) => {
        if (el) el.style.paddingInlineStart = `${depth * 16}px`;
      }}
    >
      {children}
    </div>
  );
}
