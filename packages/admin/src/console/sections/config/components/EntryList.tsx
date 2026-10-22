import * as React from "react";
import { AlertCircle, GitMerge, Pencil, Plus, Search } from "lucide-react";
import type { ConfigEntry } from "../../../../api.js";
import { cn } from "../../../../lib/cn.js";
import { categoryLabel } from "../../../../schema/index.js";
import { Button } from "../../../../ui/Button.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { Input } from "../../../../ui/Input.js";
import { Unlocked } from "../../../../ui/WriteLock.js";
import { ENTRY_TYPE_LABELS, entryType } from "./entryType.js";
import { TypeGlyph } from "./EditorParts.js";

export interface EntryRow {
  entry: ConfigEntry;
  index: number;
}

/**
 * The editor's entry list (config.entry-setting): a card with the search, every entry grouped by
 * category with one glyph per type and its change, conflict and error marks, a key to the glyphs
 * and Add entry. Search only reads, so it stays usable under a view-only lock.
 */
export function EntryList({
  groups,
  selectedIndex,
  query,
  onQuery,
  changeOf,
  hasErrors,
  conflictKeys,
  removedKeys,
  onSelect,
  onAdd,
}: {
  groups: Map<string, EntryRow[]>;
  selectedIndex: number;
  query: string;
  onQuery: (q: string) => void;
  changeOf: (key: string) => "added" | "changed" | null;
  hasErrors: (index: number) => boolean;
  conflictKeys: Set<string>;
  /** Keys this draft removes. */
  removedKeys: string[];
  onSelect: (index: number, key: string) => void;
  onAdd: () => void;
}): React.ReactElement {
  return (
    // A single track below 1024 px: a long key truncates, and the list scrolls in a short box.
    <nav
      aria-label="Catalog entries"
      className="relative min-w-0 space-y-4 rounded-lg border border-border bg-surface-raised p-2 lg:sticky lg:top-20 lg:self-start"
    >
      <Unlocked>
        <div className="relative px-1 pt-1">
          <Search
            aria-hidden
            className="pointer-events-none absolute start-4 top-1/2 size-4 -translate-y-1/2 text-fg-muted"
          />
          <Input
            type="search"
            aria-label="Search entries"
            placeholder="Search entries"
            className="ps-9"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
          />
        </div>
      </Unlocked>
      <div className="relative max-h-64 space-y-4 overflow-y-auto pk-scroll lg:max-h-[calc(100dvh-18rem)]">
        {groups.size === 0 ? (
          <EmptyState
            kind="no-results"
            title="No entries match"
            filters={query.trim() ? `“${query.trim()}”` : ""}
            onClearFilters={() => onQuery("")}
          />
        ) : (
          [...groups].map(([category, items]) => {
            const changed = items.filter((i) => changeOf(i.entry.key)).length;
            const errors = items.filter((i) => hasErrors(i.index)).length;
            return (
              <section key={category} className="space-y-1">
                <h2 className="flex items-center gap-2 px-2 text-xs font-semibold text-fg-muted">
                  <span className="flex-1">{categoryLabel(category)}</span>
                  <span className="tabular-nums">{items.length}</span>
                  {changed ? (
                    <span className="inline-flex items-center gap-0.5 text-accent-fg">
                      <Pencil aria-hidden className="size-3" />
                      {changed}
                      <span className="sr-only"> changed</span>
                    </span>
                  ) : null}
                  {errors ? (
                    <span className="inline-flex items-center gap-0.5 text-danger">
                      <AlertCircle aria-hidden className="size-3" />
                      {errors}
                      <span className="sr-only"> with errors</span>
                    </span>
                  ) : null}
                </h2>
                <ul>
                  {items.map(({ entry, index }) => {
                    const change = changeOf(entry.key);
                    const current = index === selectedIndex;
                    return (
                      <li key={`${index}:${entry.key}`}>
                        <button
                          type="button"
                          aria-current={current ? "true" : undefined}
                          onClick={() => onSelect(index, entry.key)}
                          className={cn(
                            "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start font-mono text-xs",
                            "focus-visible:outline-2 focus-visible:outline-focus",
                            current
                              ? "bg-accent-subtle text-fg-strong"
                              : "text-fg hover:bg-hover",
                          )}
                        >
                          <TypeGlyph type={entryType(entry)} />
                          <span
                            className="min-w-0 flex-1 truncate"
                            title={entry.key || undefined}
                          >
                            {entry.key || "(no key)"}
                          </span>
                          {change === "added" ? (
                            <span className="text-success">
                              <Plus aria-hidden className="size-3" />
                              <span className="sr-only">(added)</span>
                            </span>
                          ) : change === "changed" ? (
                            <span className="text-accent-fg">
                              <Pencil aria-hidden className="size-3" />
                              <span className="sr-only">(changed)</span>
                            </span>
                          ) : null}
                          {conflictKeys.has(entry.key) ? (
                            <span className="text-warning">
                              <GitMerge aria-hidden className="size-3" />
                              <span className="sr-only">
                                (conflicts with the repository)
                              </span>
                            </span>
                          ) : null}
                          {hasErrors(index) ? (
                            <span className="text-danger">
                              <AlertCircle aria-hidden className="size-3" />
                              <span className="sr-only">(has errors)</span>
                            </span>
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })
        )}
        {removedKeys.length ? (
          <section className="space-y-1">
            <h2 className="px-2 text-xs font-semibold text-fg-muted">
              Removed in this draft
            </h2>
            <ul className="px-2 font-mono text-xs text-danger">
              {removedKeys.map((key) => (
                <li key={key} className="truncate line-through">
                  {key}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
      <div className="space-y-3 border-t border-border px-1 pt-3">
        <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-fg-muted">
          {(["setting", "secret", "minted"] as const).map((t) => (
            <li key={t} className="inline-flex items-center gap-1">
              <TypeGlyph type={t} />
              {ENTRY_TYPE_LABELS[t]}
            </li>
          ))}
        </ul>
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          iconStart={<Plus aria-hidden />}
          onClick={onAdd}
        >
          Add entry
        </Button>
      </div>
    </nav>
  );
}
