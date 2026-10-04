import * as React from "react";
import { AlertCircle, Pencil, Plus, Trash2 } from "lucide-react";
import {
  ApiError,
  type ConfigEntry,
  type ProductCatalog,
} from "../../../api.js";
import { invalidate } from "../../../context.js";
import { cn } from "../../../lib/cn.js";
import { diffSummary } from "../../../lib/diff.js";
import { errorCopy } from "../../../lib/errorCopy.js";
import { KIND_LABELS } from "../../../lib/labels.js";
import {
  UNCATEGORISED,
  catalogDiagnostics,
  catalogIssues,
  type CatalogIssue,
} from "../../../schema/index.js";
import { Button } from "../../../ui/Button.js";
import { Callout } from "../../../ui/Callout.js";
import { Checkbox } from "../../../ui/Checkbox.js";
import { CodeEditor } from "../../../ui/CodeEditor.js";
import { DiffViewer } from "../../../ui/DiffViewer.js";
import { Drawer, DrawerBody, DrawerFooter } from "../../../ui/Drawer.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { Input } from "../../../ui/Input.js";
import { SegmentedControl } from "../../../ui/SegmentedControl.js";
import { Select } from "../../../ui/Select.js";
import { PageSkeleton } from "../../../ui/Skeleton.js";
import { SourceBadge } from "../../../ui/SourceBadge.js";
import { toast } from "../../../ui/toast.js";
import { Breadcrumbs } from "../../components/Breadcrumbs.js";
import { PageHeader } from "../../components/PageHeader.js";
import { useProduct } from "../../data/hooks.js";
import { mutate } from "../../data/mutations.js";
import { qk } from "../../data/queries.js";
import { codecs, navigate, useSearchParam } from "../../router.js";
import { r } from "../../routes.js";
import { CatalogEntryForm } from "./CatalogEntryForm.js";
import {
  clearDraft,
  draftDiff,
  draftDocument,
  draftFrom,
  loadDraft,
  newEntry,
  saveDraft,
  type CatalogDraft,
} from "./catalogDraft.js";
import {
  CATALOG_PATH,
  catalogSource,
  isNotFound,
  useCatalog,
  useCatalogUsage,
} from "./data.js";

const MODE = codecs.oneOf(["form", "json"] as const, "form");
const KIND = codecs.oneOf(["all", "config", "secret", "flag"] as const, "all");
const CHANGED = codecs.oneOf(["0", "1"] as const, "0");

/**
 * Config → Catalog → Edit (docs/design/ADMIN.md §6.6.2, T7): the catalog editor.
 *
 * - **Form mode** edits one entry at a time from a list grouped by category, with change and
 *   error markers; **JSON mode** edits the whole document in CodeMirror with the catalog
 *   validator as its linter and Format (CAT-4). Both edit one draft.
 * - The draft persists in `sessionStorage` (CAT-6); the bumped version is in the title.
 * - **Review** is a structured diff. Removed keys are cross-checked against what still sets them
 *   (A-7b); a breaking removal needs the acknowledgement (L2). Errors stay inline (CAT-6).
 * - **Publish** sends `expectedVersion` (A-6); a 409 shows what changed on the server.
 * - With no catalog yet the draft starts from `{schemaVersion: 1, entries: []}` (CAT-1).
 */
export function CatalogEditorPage({
  slug,
}: {
  slug: string;
}): React.ReactElement {
  const catalog = useCatalog(slug);
  const { data: product } = useProduct(slug);
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
    <Editor
      slug={slug}
      draft={draft}
      setDraft={setDraft}
      server={catalog.data ?? null}
      source={catalogSource(product)}
      onDiscard={() => {
        clearDraft(slug);
        setDraftState(draftFrom(catalog.data ?? null));
      }}
    />
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
  onDiscard,
}: {
  slug: string;
  draft: CatalogDraft;
  setDraft: (next: CatalogDraft) => void;
  server: ProductCatalog | null;
  source: "manifest" | "admin";
  onDiscard: () => void;
}): React.ReactElement {
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
  // A restored draft with no changes simply follows the server's newer version.
  React.useEffect(() => {
    if (
      server !== null &&
      server.schemaVersion !== draft.baseVersion &&
      diff.all.length === 0
    )
      setDraft(draftFrom(server));
  }, [server, draft.baseVersion, diff, setDraft]);
  const issues = React.useMemo(
    () => catalogIssues(draftDocument(draft)),
    [draft],
  );
  const dirty = diff.all.length > 0;
  const nextVersion = draft.baseVersion + 1;
  const stale = server !== null && server.schemaVersion !== draft.baseVersion;

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
    .filter(({ entry }) => kind === "all" || entry.kind === kind)
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

  // The entry being edited, by position while its key is being typed (a key that briefly
  // matches another entry's must not move the selection to that entry).
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
          <span className="text-sm text-fg-muted">
            {draft.baseVersion > 0
              ? `v${draft.baseVersion} → v${nextVersion} (draft)`
              : `v${nextVersion} (draft)`}
          </span>
        }
        meta={<SourceBadge source={source} path={CATALOG_PATH} />}
      />

      {stale ? (
        <Callout
          tone="warning"
          live
          title={`The catalog changed since you started (v${draft.baseVersion} → v${server!.schemaVersion})`}
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={() => setReviewing(true)}
            >
              Review
            </Button>
          }
        >
          Your draft was started from v{draft.baseVersion}. Review what changed
          before you publish, or discard your draft to start from v
          {server!.schemaVersion}.
        </Callout>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        {mode === "json" ? <div className="flex-1" /> : null}
        <div className={cn("min-w-48 flex-1", mode === "json" && "hidden")}>
          <Input
            type="search"
            aria-label="Search entries"
            placeholder="Search key, label, category…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className={cn("w-40", mode === "json" && "hidden")}>
          <Select
            aria-label="Kind"
            value={kind}
            options={[
              { value: "all", label: "All kinds" },
              ...(["config", "secret", "flag"] as const).map((k) => ({
                value: k,
                label: KIND_LABELS[k]!,
              })),
            ]}
            onChange={(v) => setKind((v ?? "all") as typeof kind)}
          />
        </div>
        {mode === "json" ? null : (
          <Checkbox
            label="Changed only"
            checked={changedOnly === "1"}
            onCheckedChange={(on) => setChangedOnly(on ? "1" : "0")}
          />
        )}
        <SegmentedControl<"form" | "json">
          aria-label="Editing mode"
          value={mode}
          onChange={(m) => setMode(m)}
          options={[
            { value: "form", label: "Form" },
            { value: "json", label: "JSON" },
          ]}
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
          description="Add the first config, secret or flag entry. Publishing creates the catalog."
          primaryAction={
            <Button iconStart={<Plus aria-hidden />} onClick={addEntry}>
              Add entry
            </Button>
          }
        />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <nav aria-label="Catalog entries" className="space-y-4">
            {visible.length === 0 ? (
              <EmptyState
                kind="no-results"
                title="No entries match"
                filters={[
                  needle ? `“${query.trim()}”` : null,
                  kind !== "all" ? `kind: ${kind}` : null,
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
                    <h2 className="flex items-center gap-2 px-2 text-xs font-bold text-fg-muted">
                      <span className="flex-1">{category}</span>
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
                                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-mono text-xs",
                                "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus",
                                current
                                  ? "bg-accent-subtle text-fg-strong"
                                  : "text-fg hover:bg-hover",
                              )}
                            >
                              <span className="min-w-0 flex-1 truncate">
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
                <h2 className="px-2 text-xs font-bold text-fg-muted">
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
            className="min-w-0 rounded-lg border border-border bg-surface-raised p-4"
          >
            {selected ? (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="font-mono text-sm font-bold text-fg-strong">
                    {selected.key || "(no key)"}
                  </h2>
                  <Button
                    size="sm"
                    variant="outline"
                    iconStart={<Trash2 aria-hidden />}
                    onClick={() => removeEntry(selectedIndex)}
                  >
                    Remove entry
                  </Button>
                </div>
                <CatalogEntryForm
                  key={selectedIndex}
                  entry={selected}
                  issues={issuesAt(selectedIndex)}
                  categories={categories}
                  onChange={(next) => updateEntry(selectedIndex, next)}
                />
              </div>
            ) : (
              <p className="py-12 text-center text-sm text-fg-muted">
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
              <>
                {summary}
                <span className="block text-xs text-fg-muted">
                  The draft stays in this tab until you publish or discard it.
                </span>
              </>
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
                disabledReason={
                  !dirty
                    ? "Nothing has changed yet."
                    : issues.length
                      ? "Fix the errors in the draft first."
                      : undefined
                }
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
        blocked={issues.length > 0}
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

// ── JSON mode (CAT-4) ──────────────────────────────────────────────────────────────────────────

function JsonMode({
  draft,
  setDraft,
}: {
  draft: CatalogDraft;
  setDraft: (next: CatalogDraft) => void;
}): React.ReactElement {
  const serialised = React.useMemo(
    () => `${JSON.stringify(draftDocument(draft), null, 2)}\n`,
    [draft],
  );
  const [text, setText] = React.useState(serialised);
  const emitted = React.useRef(serialised);
  // Follow the draft when it changes from outside (Undo, a discard), never on our own echo.
  React.useEffect(() => {
    if (serialised === emitted.current) return;
    emitted.current = serialised;
    setText(serialised);
  }, [serialised]);

  const labelId = React.useId();
  return (
    <div className="space-y-2">
      <p id={labelId} className="text-sm text-fg-muted">
        The whole catalog as JSON. Changes apply to the draft while the text is
        valid JSON with an entries array; the version is assigned when you
        publish.
      </p>
      <CodeEditor
        language="json"
        value={text}
        formattable
        heightClass="h-[32rem]"
        aria-labelledby={labelId}
        validate={catalogDiagnostics}
        onChange={(next) => {
          setText(next);
          try {
            const doc = JSON.parse(next) as { entries?: unknown };
            if (Array.isArray(doc.entries)) {
              const updated = {
                ...draft,
                entries: doc.entries as ConfigEntry[],
              };
              emitted.current = `${JSON.stringify(draftDocument(updated), null, 2)}\n`;
              setDraft(updated);
            }
          } catch {
            // Not JSON yet: the linter marks it; the draft keeps its last good state.
          }
        }}
      />
    </div>
  );
}

// ── review and publish ─────────────────────────────────────────────────────────────────────────

function ReviewDrawer({
  slug,
  open,
  onOpenChange,
  draft,
  setDraft,
  server,
  source,
  blocked,
  onPublished,
  onDiscard,
}: {
  slug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draft: CatalogDraft;
  setDraft: (next: CatalogDraft) => void;
  server: ProductCatalog | null;
  source: "manifest" | "admin";
  blocked: boolean;
  onPublished: (version: number) => void;
  onDiscard: () => void;
}): React.ReactElement {
  const diff = React.useMemo(() => draftDiff(draft), [draft]);
  const removedKeys = React.useMemo(
    () => (open ? diff.removed.map((c) => c.key) : []),
    [open, diff],
  );
  const usage = useCatalogUsage(slug, removedKeys);
  const [ack, setAck] = React.useState(false);
  const [publishing, setPublishing] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  React.useEffect(() => {
    if (!open) {
      setAck(false);
      setError(null);
    }
  }, [open]);

  const referencedBy: Record<string, string[]> = {};
  const profilesAffected = new Set<string>();
  for (const key of removedKeys) {
    const u = usage.data?.keys[key];
    if (!u) continue;
    const refs = [
      ...u.profiles.map((p) => `profile ${p.id}`),
      ...u.licenses.map((l) => `license ${l.name || l.id}`),
    ];
    for (const p of u.profiles) profilesAffected.add(p.id);
    if (refs.length) referencedBy[key] = refs;
  }
  const breaking = Object.keys(referencedBy).length > 0;
  const conflict =
    error instanceof ApiError &&
    error.status === 409 &&
    error.reason === "catalog_version_conflict";
  const stale = server !== null && server.schemaVersion !== draft.baseVersion;
  const nextVersion = (server?.schemaVersion ?? draft.baseVersion) + 1;

  const publish = async (): Promise<void> => {
    setPublishing(true);
    setError(null);
    try {
      const res = await mutate(
        "publishSchema",
        slug,
        draftDocument(draft),
        draft.baseVersion,
      );
      onOpenChange(false);
      onPublished(res.schemaVersion);
    } catch (err) {
      setError(err);
      if (err instanceof ApiError && err.status === 409)
        invalidate(qk.catalog(slug));
    } finally {
      setPublishing(false);
    }
  };

  const copy =
    error && !conflict ? errorCopy(error, { thing: "Catalog" }) : null;

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      dismissible={!publishing}
      size="lg"
      title={
        stale || conflict
          ? "The catalog changed since you started"
          : `Publish version ${draft.baseVersion + 1}`
      }
      description={
        stale || conflict
          ? undefined
          : "What changes for every client when this version is published."
      }
    >
      <DrawerBody>
        <div className="space-y-6">
          {(stale || conflict) && server ? (
            <section className="space-y-3" aria-label="Changes on the server">
              <Callout tone="warning" live>
                v{server.schemaVersion} was published after you started from v
                {draft.baseVersion}. These are its changes. Publish over it to
                replace them with your draft, or discard your draft.
              </Callout>
              <DiffViewer<ConfigEntry>
                mode="structured"
                before={draft.baseEntries}
                after={server.entries}
                entryKey="key"
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    setError(null);
                    setDraft({
                      ...draft,
                      baseVersion: server.schemaVersion,
                      baseEntries: server.entries,
                    });
                  }}
                >
                  Review my draft against v{server.schemaVersion}
                </Button>
                <Button variant="ghost" onClick={onDiscard}>
                  Discard my draft
                </Button>
              </div>
            </section>
          ) : (
            <>
              <DiffViewer<ConfigEntry>
                mode="structured"
                before={draft.baseEntries}
                after={draft.entries}
                entryKey="key"
                referencedBy={referencedBy}
              />
              {usage.isFetching ? (
                <p className="text-sm text-fg-muted">
                  Checking what still uses the removed keys…
                </p>
              ) : null}
              {usage.error ? (
                <ErrorState
                  compact
                  error={usage.error}
                  onRetry={() => void usage.refetch()}
                />
              ) : null}
              {source === "manifest" ? (
                <Callout tone="warning" title="This catalog is manifest-owned">
                  The next resync from the repository re-applies{" "}
                  <code className="font-mono text-xs">{CATALOG_PATH}</code> over
                  this publish. Make the same change in the repository to keep
                  it.
                </Callout>
              ) : null}
              {breaking ? (
                <Checkbox
                  label={`I understand removed keys are dropped from ${profilesAffected.size} ${profilesAffected.size === 1 ? "profile's" : "profiles'"} payloads and the licenses listed above`}
                  checked={ack}
                  onCheckedChange={setAck}
                />
              ) : null}
              {copy ? (
                <div
                  role="alert"
                  className="rounded-md border border-danger-border bg-danger-subtle p-3 text-sm"
                >
                  <p className="font-bold text-danger">{copy.title}</p>
                  <p className="text-fg">{copy.description}</p>
                  {copy.fieldErrors?.length ? (
                    <ul className="mt-1 list-disc pl-5 font-mono text-xs">
                      {copy.fieldErrors.map((f) => (
                        <li key={f}>{f}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button
          variant="ghost"
          disabled={publishing}
          onClick={() => onOpenChange(false)}
        >
          Back to editing
        </Button>
        {stale || conflict ? null : (
          <Button
            variant={breaking ? "danger" : "primary"}
            loading={publishing}
            disabledReason={
              blocked
                ? "Fix the errors in the draft first."
                : diff.all.length === 0
                  ? "Nothing has changed yet."
                  : breaking && !ack
                    ? "Confirm that removed keys are dropped."
                    : usage.isFetching
                      ? "Checking the removed keys…"
                      : undefined
            }
            onClick={() => void publish()}
          >
            Publish version {nextVersion}
          </Button>
        )}
      </DrawerFooter>
    </Drawer>
  );
}
