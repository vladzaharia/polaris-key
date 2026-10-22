import * as React from "react";
import { AlertCircle, GitMerge, Pencil, Plus } from "lucide-react";
import type { ConfigEntry, ProductCatalog } from "../../../../api.js";
import { cn } from "../../../../lib/cn.js";
import { diffSummary } from "../../../../lib/diff.js";
import {
  UNCATEGORISED,
  categoryLabel,
  catalogIssues,
  type CatalogIssue,
} from "../../../../schema/index.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { PageSkeleton } from "../../../../ui/Skeleton.js";
import { SourceBadge } from "../../../../ui/SourceBadge.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { toast } from "../../../../ui/toast.js";
import { Breadcrumbs } from "../../../components/Breadcrumbs.js";
import { PageHeader } from "../../../../ui/PageHeader.js";
import { useProduct } from "../../../data/hooks.js";
import { codecs, navigate, useSearchParam } from "../../../router.js";
import { r } from "../../../routes.js";
import { EntryPane } from "../components/EntryPane.js";
import { CatalogFilters, ViewOnlyNote } from "../components/CatalogFilters.js";
import { WriteLock } from "../../../../ui/WriteLock.js";
import { useWriteGate } from "../../../access/useCan.js";
import {
  ConflictPanel,
  JsonMode,
  TypeGlyph,
} from "../components/EditorParts.js";
import { ReviewDrawer } from "../components/ReviewDrawer.js";
import { blockedKeys, useRemovals } from "../components/RemovedValues.js";
import {
  clearDraft,
  draftDiff,
  draftDocument,
  draftFrom,
  loadDraft,
  newEntry,
  saveDraft,
  type CatalogDraft,
} from "../model/catalogDraft.js";
import {
  CATALOG_PATH,
  catalogSource,
  isNotFound,
  useCatalog,
} from "../data.js";
import { ENTRY_TYPE_LABELS, entryType } from "../components/entryType.js";
import { WHOLE_ENTRY, mergeDraft, settle } from "../model/mergeDraft.js";

const MODE = codecs.oneOf(["form", "json"] as const, "form");
const KIND = codecs.oneOf(
  ["all", "setting", "secret", "minted", "flag"] as const,
  "all",
);
const CHANGED = codecs.oneOf(["0", "1"] as const, "0");

/**
 * Config → Catalog → Edit (docs/design/ADMIN.md §6.6.2, T7): the catalog editor.
 *
 * - **Form mode** edits one entry at a time from a list grouped by category, with change and
 *   error markers; **JSON mode** edits the whole document in CodeMirror with the catalog
 *   validator as its linter and Format (CAT-4). Both edit one draft.
 * - The draft persists in `sessionStorage` (CAT-6); the header carries one "Draft v9" chip with
 *   the version publishing creates (EXPERIENCE.md §0.4 S4). A view-only member gets no editor.
 * - **Review** is a structured diff; removed keys are cross-checked against what still sets them
 *   (A-7b) and a breaking removal needs the acknowledgement (L2). Errors stay inline (CAT-6).
 * - **Publish** sends `expectedVersion` (A-6); a 409 shows what changed on the server. With no
 *   catalog the draft starts from `{schemaVersion: 1, entries: []}` (CAT-1).
 */
export function CatalogEditorPage({
  slug,
}: {
  slug: string;
}): React.ReactElement {
  const catalog = useCatalog(slug);
  const { data: product } = useProduct(slug);
  const gate = useWriteGate("config", slug);
  const missing = isNotFound(catalog.error);
  const loaded = catalog.data !== undefined || missing;

  const [draft, setDraftState] = React.useState<CatalogDraft | null>(null);
  React.useEffect(() => {
    if (draft || !loaded) return;
    setDraftState(loadDraft(slug) ?? draftFrom(catalog.data ?? null));
  }, [draft, loaded, slug, catalog.data]);

  const setDraft = React.useCallback(
    (next: CatalogDraft) => {
      setDraftState(next);
      saveDraft(slug, next);
    },
    [slug],
  );

  if (catalog.error && !missing) {
    return (
      <div className="space-y-6" data-template="editor">
        <EditorHeader slug={slug} title="Edit catalog" />
        <ErrorState
          error={catalog.error}
          onRetry={() => void catalog.refetch()}
          context={{ thing: "Catalog" }}
        />
      </div>
    );
  }
  if (!draft) return <PageSkeleton template="form" label="the catalog" />;

  return (
    <WriteLock locked={!gate.allowed} reason={gate.disabledReason}>
      <Editor
        slug={slug}
        draft={draft}
        setDraft={setDraft}
        server={catalog.data ?? null}
        source={catalogSource(product)}
        authoritative={product?.manifestAuthoritative?.value ?? false}
        onDiscard={() => {
          clearDraft(slug);
          setDraftState(draftFrom(catalog.data ?? null));
        }}
      />
    </WriteLock>
  );
}

function EditorHeader({
  slug,
  title,
  aside,
  meta,
}: {
  slug: string;
  title: string;
  aside?: React.ReactNode;
  meta?: React.ReactNode;
}): React.ReactElement {
  return (
    <PageHeader
      eyebrow={
        <Breadcrumbs
          items={[{ label: "Catalog", to: r.catalog(slug) }, { label: "Edit" }]}
        />
      }
      title={title}
      titleAside={aside}
      meta={meta}
      sticky
    />
  );
}

function Editor({
  slug,
  draft,
  setDraft,
  server,
  source,
  authoritative,
  onDiscard,
}: {
  slug: string;
  draft: CatalogDraft;
  setDraft: (next: CatalogDraft) => void;
  server: ProductCatalog | null;
  source: "manifest" | "admin";
  /** ST-20: the product is manifest-authoritative, so a publish is a break-glass claim. */
  authoritative: boolean;
  onDiscard: () => void;
}): React.ReactElement {
  const { data: product } = useProduct(slug);
  const [mode, setMode] = useSearchParam("mode", MODE);
  const [selectedKey, setSelectedKey] = useSearchParam(
    "entry",
    codecs.string(),
  );
  const [query, setQuery] = useSearchParam("q", codecs.string());
  const [kind, setKind] = useSearchParam("kind", KIND);
  const [changedOnly, setChangedOnly] = useSearchParam("changed", CHANGED);
  const [reviewing, setReviewing] = React.useState(false);
  const [confirmDiscard, setConfirmDiscard] = React.useState(false);

  const diff = React.useMemo(() => draftDiff(draft), [draft]);
  // A restored draft with no changes simply follows the server's newer version; one with edits is
  // merged onto it, and only the fields both sides changed are left to settle (admin-2-21).
  const commit = product?.sync?.commitSha ?? null;
  React.useEffect(() => {
    // Not under an open review: it shows the server's changes itself and merges on request.
    if (server === null || server.schemaVersion === draft.baseVersion) return;
    if (reviewing && diff.all.length > 0) return;
    setDraft(
      diff.all.length === 0
        ? draftFrom(server)
        : { ...mergeDraft(draft, server), rebasedOnto: commit },
    );
  }, [server, draft, diff, commit, reviewing, setDraft]);
  const issues = React.useMemo(
    () => catalogIssues(draftDocument(draft)),
    [draft],
  );
  const dirty = diff.all.length > 0;
  const nextVersion = draft.baseVersion + 1;
  const conflicts = draft.conflicts ?? [];
  const conflictCount = conflicts.reduce((n, c) => n + c.fields.length, 0);
  const conflictKeys = new Set(conflicts.map((c) => c.key));
  const { removals, pending: removalsPending } = useRemovals(slug, draft);
  const heldKeys = blockedKeys(removals);
  const holdReason =
    conflictCount > 0
      ? `Settle ${conflictCount === 1 ? "the conflict" : `the ${conflictCount} conflicts`} with the repository first.`
      : heldKeys.length > 0
        ? "Change what still uses a removed value first."
        : removalsPending
          ? "Checking what uses the removed values…"
          : undefined;

  const changeOf = (key: string): "added" | "changed" | null => {
    if (diff.added.some((c) => c.key === key)) return "added";
    if (diff.changed.some((c) => c.key === key)) return "changed";
    return null;
  };
  const issuesAt = (index: number): CatalogIssue[] =>
    issues.filter((i) => i.index === index);

  const entries = draft.entries;
  const categories = [
    ...new Set(entries.map((e) => e.category || UNCATEGORISED)),
  ];
  const needle = query.trim().toLowerCase();
  const visible = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => kind === "all" || entryType(entry) === kind)
    .filter(({ entry }) => changedOnly === "0" || changeOf(entry.key) !== null)
    .filter(
      ({ entry }) =>
        needle === "" ||
        [entry.key, entry.label, entry.description, entry.category]
          .join(" ")
          .toLowerCase()
          .includes(needle),
    );
  const groups = new Map<string, { entry: ConfigEntry; index: number }[]>();
  for (const item of visible) {
    const cat = item.entry.category || UNCATEGORISED;
    groups.set(cat, [...(groups.get(cat) ?? []), item]);
  }

  // The entry being edited, by position while its key is typed (a briefly matching key must not jump).
  const [pinned, setPinned] = React.useState<number | null>(null);
  const selectedIndex =
    pinned !== null && pinned < entries.length
      ? pinned
      : entries.findIndex((e) => e.key === selectedKey);
  const selected = selectedIndex >= 0 ? entries[selectedIndex]! : null;

  const updateEntry = (index: number, next: ConfigEntry): void => {
    const list = [...entries];
    list[index] = next;
    setDraft({ ...draft, entries: list });
    setPinned(index);
    if (index === selectedIndex && next.key !== selectedKey)
      setSelectedKey(next.key);
  };
  const addEntry = (): void => {
    const entry = newEntry(
      entries,
      selected?.category || categories[0] || UNCATEGORISED,
    );
    setDraft({ ...draft, entries: [...entries, entry] });
    setPinned(entries.length);
    setSelectedKey(entry.key);
    setMode("form");
  };
  const removeEntry = (index: number): void => {
    const removed = entries[index]!;
    setDraft({ ...draft, entries: entries.filter((_, i) => i !== index) });
    setPinned(null);
    setSelectedKey("");
    toast.success(`Removed ${removed.key} from the draft`, {
      description: "It is dropped from the catalog when you publish.",
      action: {
        label: "Undo",
        onClick: () =>
          setDraft({
            ...draft,
            entries: [
              ...entries.slice(0, index),
              removed,
              ...entries.slice(index),
            ],
          }),
      },
    });
  };

  const summary = `${diffSummary(diff)}${
    issues.length
      ? ` · ${issues.length} ${issues.length === 1 ? "error" : "errors"}`
      : ""
  }`;

  return (
    <div className="space-y-6" data-template="editor">
      <EditorHeader
        slug={slug}
        title="Edit catalog"
        aside={
          <span className="inline-flex flex-wrap items-center gap-2">
            <StatusPill tone="neutral" icon={false} size="sm">
              Draft v{nextVersion}
            </StatusPill>
            <SourceBadge source={source} path={CATALOG_PATH} />
          </span>
        }
      />

      {conflictCount > 0 ? (
        <Callout
          tone="warning"
          live
          title={`v${draft.baseVersion} arrived ${source === "manifest" ? `from ${CATALOG_PATH} ` : ""}while you edited`}
        >
          <p id="conflict-note">
            {draft.rebasedOnto ? (
              <>
                Commit{" "}
                <code className="font-mono text-xs">
                  {draft.rebasedOnto.slice(0, 7)}
                </code>
                .{" "}
              </>
            ) : null}
            {conflictCount === 1
              ? "1 of your edits conflicts."
              : `${conflictCount} of your edits conflict.`}{" "}
            The rest merged in. Pick a side for each; nothing is lost until you
            publish.
          </p>
          {conflicts
            .filter(
              (c) =>
                c.fields.some((f) => f.field === WHOLE_ENTRY) &&
                !entries.some((e) => e.key === c.key),
            )
            .map((c) => (
              <div key={c.key} className="mt-3">
                <ConflictPanel
                  conflict={c}
                  onSettle={(field, take) =>
                    setDraft(settle(draft, c.key, field, take))
                  }
                />
              </div>
            ))}
        </Callout>
      ) : null}

      <ViewOnlyNote />

      <div className="flex flex-wrap items-center gap-3">
        <CatalogFilters
          mode={mode}
          setMode={setMode}
          query={query}
          setQuery={setQuery}
          kind={kind}
          setKind={setKind}
          changedOnly={changedOnly}
          setChangedOnly={setChangedOnly}
          hasFlags={entries.some((e) => e.kind === "flag")}
        />
        <Button
          variant="outline"
          iconStart={<Plus aria-hidden />}
          onClick={addEntry}
        >
          Add entry
        </Button>
      </div>

      {mode === "json" ? (
        <JsonMode draft={draft} setDraft={setDraft} />
      ) : entries.length === 0 ? (
        <EmptyState
          kind="first-run"
          headingLevel={2}
          title="No entries yet"
          description="Add the first setting, secret or minted token. Publishing creates the catalog."
          primaryAction={
            <Button iconStart={<Plus aria-hidden />} onClick={addEntry}>
              Add entry
            </Button>
          }
        />
      ) : (
        // A single track below 1024 px: a long key truncates, and the list scrolls in a short box.
        <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <nav
            aria-label="Catalog entries"
            className="relative min-w-0 max-h-64 space-y-4 overflow-y-auto rounded-lg border border-border p-2 pk-scroll lg:max-h-none lg:overflow-visible lg:rounded-none lg:border-0 lg:p-0"
          >
            {visible.length === 0 ? (
              <EmptyState
                kind="no-results"
                title="No entries match"
                filters={[
                  needle ? `“${query.trim()}”` : null,
                  kind !== "all" ? `type: ${ENTRY_TYPE_LABELS[kind]}` : null,
                  changedOnly === "1" ? "changed only" : null,
                ]
                  .filter(Boolean)
                  .join(", ")}
                onClearFilters={() => {
                  setQuery("");
                  setKind("all");
                  setChangedOnly("0");
                }}
              />
            ) : (
              [...groups].map(([category, items]) => {
                const changed = items.filter((i) =>
                  changeOf(i.entry.key),
                ).length;
                const errors = items.filter(
                  (i) => issuesAt(i.index).length,
                ).length;
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
                        const bad = issuesAt(index).length > 0;
                        const current = index === selectedIndex;
                        return (
                          <li key={`${index}:${entry.key}`}>
                            <button
                              type="button"
                              aria-current={current ? "true" : undefined}
                              onClick={() => {
                                setPinned(index);
                                setSelectedKey(entry.key);
                              }}
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
                              {bad ? (
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
            {diff.removed.length ? (
              <section className="space-y-1">
                <h2 className="px-2 text-xs font-semibold text-fg-muted">
                  Removed in this draft
                </h2>
                <ul className="px-2 font-mono text-xs text-danger">
                  {diff.removed.map((c) => (
                    <li key={c.key} className="truncate line-through">
                      {c.key}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </nav>

          <section
            aria-label={selected ? `Entry ${selected.key}` : "Entry"}
            // Its own height, not the key list's (a long list would stretch it into a tall empty card).
            className="min-w-0 max-w-[55rem] self-start"
          >
            {selected ? (
              <EntryPane
                key={selectedIndex}
                slug={slug}
                entry={selected}
                draft={draft}
                issues={issuesAt(selectedIndex)}
                categories={categories}
                changed={changeOf(selected.key) !== null}
                conflicts={conflicts.filter((c) => c.key === selected.key)}
                removal={removals[selected.key]}
                productName={product?.name}
                syncEnabled={product?.services?.sync?.enabled === true}
                onSettle={(key, field, take) =>
                  setDraft(settle(draft, key, field, take))
                }
                onChange={(next) => updateEntry(selectedIndex, next)}
                onRemove={() => removeEntry(selectedIndex)}
              />
            ) : (
              <p className="flex items-center justify-center rounded-lg border border-border bg-surface-raised p-4 py-8 text-center text-sm text-fg-muted lg:min-h-48">
                Choose an entry to edit it, or add one.
              </p>
            )}
          </section>
        </div>
      )}

      {dirty || issues.length > 0 ? (
        <div
          role="region"
          aria-label="Draft"
          className="sticky bottom-0 z-30 -mx-1 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border bg-surface-overlay px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-elevation-3"
        >
          <p className="min-w-0 flex-1 text-sm text-fg">
            {confirmDiscard ? (
              <span role="alert" className="text-fg-strong">
                Discard this draft? Nothing has been published.
              </span>
            ) : (
              summary
            )}
          </p>
          {confirmDiscard ? (
            <>
              <Button
                variant="ghost"
                autoFocus
                onClick={() => setConfirmDiscard(false)}
              >
                Keep editing
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  setConfirmDiscard(false);
                  onDiscard();
                }}
              >
                Discard draft
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setConfirmDiscard(true)}>
                Discard draft
              </Button>
              <Button
                // An error does not keep the review shut: it opens with the error pinned to its
                // entry and Publish waiting (config.catalog-review-states).
                disabledReason={holdReason}
                onClick={() => setReviewing(true)}
              >
                Review changes
              </Button>
            </>
          )}
        </div>
      ) : null}

      <ReviewDrawer
        slug={slug}
        open={reviewing}
        onOpenChange={setReviewing}
        draft={draft}
        setDraft={setDraft}
        server={server}
        source={source}
        authoritative={authoritative}
        issues={issues}
        holdReason={holdReason}
        onFix={(index) => {
          setReviewing(false);
          setPinned(index);
          setSelectedKey(entries[index]?.key ?? "");
          setMode("form");
        }}
        onPublished={(version) => {
          clearDraft(slug);
          toast.success(`Published catalog v${version}`);
          navigate(r.catalog(slug));
        }}
        onDiscard={() => {
          setReviewing(false);
          onDiscard();
        }}
      />
    </div>
  );
}
