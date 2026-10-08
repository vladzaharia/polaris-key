import * as React from "react";
import { ArrowDown, ChevronDown, Search } from "lucide-react";
import type {
  ConfigEntry,
  ManagedEntry,
  ManagedSecretView,
  ManagementState,
  OverrideUpdate,
  ProductCatalog,
  RedactedPayload,
} from "./api.js";
import { r } from "./console/routes.js";
import { Link } from "./console/router.js";
import { cn } from "./lib/cn.js";
import { MANAGEMENT_LABELS } from "./lib/labels.js";
import { Button } from "./ui/Button.js";
import { Callout } from "./ui/Callout.js";
import { Drawer, DrawerBody, DrawerFooter } from "./ui/Drawer.js";
import { EmptyState } from "./ui/EmptyState.js";
import { useAdminForm } from "./ui/form.js";
import { Input } from "./ui/Input.js";
import { SaveBar } from "./ui/SaveBar.js";
import { StatusPill } from "./ui/StatusPill.js";
import {
  ManagedField,
  UNCATEGORISED,
  categoryLabel,
  entryDefault,
  formatValue,
  groupByCategory,
  initialValueFor,
  isSecretEntry,
  useCatalog,
  validateEntry,
  type InheritedValue,
} from "./schema/index.js";

/**
 * The managed-payload editor (docs/design/ADMIN.md §6.6.3): ONE component behind both
 * catalog-driven editing surfaces, a profile's payload and a license's overrides. They differ only
 * in what they do with the batch and in whether a lower layer of the stack has anything to say,
 * so they differ only by props.
 *
 * ── WHAT THE REBUILD FIXES ───────────────────────────────────────────────────────────────────
 *
 * - MPE-1: the draft lives in `useAdminForm`, which re-seeds only while the draft is clean. A
 *   background refetch never wipes an edit; when the server moves under a dirty draft the editor
 *   says so and offers "Keep mine" / "Take theirs". After a save, the refetch that holds the
 *   draft is taken silently.
 * - MPE-2: only CHANGED rows block a save. A stale invalid value on a row nobody touched is
 *   shown, never counted. Each group shows its own error count and the bar has "Jump to first
 *   error", which opens a collapsed group.
 * - MPE-3: "Review changes" lists every change with its before, after and effective value.
 * - MPE-4: search matches values too; the synthetic group for `ui.advanced` entries is "More
 *   settings" (a real "Advanced" category stays its own group); group ids are unique per editor.
 * - MPE-5: the save bar is the kit's `SaveBar` (safe-area padded); nothing imports from a view.
 *
 * ── THE THREE RULES IT KEEPS ─────────────────────────────────────────────────────────────────
 *
 * 1. SET IS NOT THE SAME AS BLANK. `applyOverrides` (worker) deletes a key whose update carries
 *    no value and state `default`, and writes one otherwise. Absent rows read "Not set", Remove
 *    returns a row to absent, and no code path sends `""` to mean "unset".
 * 2. VALIDATION IS THE SERVER'S: every value goes through `Catalog#validateEntryValue`, the call
 *    the PUT handler makes.
 * 3. A 422 LANDS ON A ROW: `fields` entries name the dotted key they concern and are matched
 *    back onto rows (longest key first) instead of being flattened into a toast.
 */

// ── working state ──────────────────────────────────────────────────────────────────────────────

/** What the server currently holds for one key. */
interface Baseline {
  set: boolean;
  value: unknown;
  state: ManagementState;
  /** Epoch seconds. */
  updatedAt: number;
  /** A write-only entry with a stored value. Its value is never on the wire, so never shown. */
  secretConfigured: boolean;
}

/** What the operator has the row at right now. */
export interface Draft {
  set: boolean;
  value: unknown;
  state: ManagementState;
}

function baselineFor(entry: ConfigEntry, payload: RedactedPayload): Baseline {
  const fallbackState = entry.managementDefault ?? "default";
  if (entry.kind === "secret") {
    const s: ManagedSecretView | undefined = payload.secrets[entry.key];
    return {
      set: s !== undefined,
      value: undefined,
      state: s?.state ?? fallbackState,
      updatedAt: s?.updatedAt ?? 0,
      secretConfigured: s?.configured ?? false,
    };
  }
  const bucket = entry.kind === "flag" ? payload.entitlements : payload.config;
  const m: ManagedEntry | undefined = bucket[entry.key];
  // A `kind: "config"` entry flagged `secret: true` lives in the config bucket but comes back
  // redacted to `value: ""` (worker `admin/lib/redact.ts`). Treat it as write-only.
  const writeOnly = isSecretEntry(entry);
  return {
    set: m !== undefined,
    value: writeOnly ? undefined : m?.value,
    state: m?.state ?? fallbackState,
    updatedAt: m?.updatedAt ?? 0,
    secretConfigured: writeOnly && m !== undefined,
  };
}

function baselines(
  entries: ConfigEntry[],
  payload: RedactedPayload,
): Map<string, Baseline> {
  const map = new Map<string, Baseline>();
  for (const entry of entries) map.set(entry.key, baselineFor(entry, payload));
  return map;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

const typedSecret = (row: Draft): boolean =>
  row.value !== undefined && row.value !== "";

/**
 * The minimal batch between the loaded payload and the draft.
 *
 * A set row ALWAYS carries its value, even when only the state moved. `applyOverrides` reads a
 * value-less update with state `default` as "delete this key", so a state-only demotion to
 * Default would silently drop the value the operator was looking at.
 */
export function diffPayload(
  entries: ConfigEntry[],
  baseline: Map<string, Baseline>,
  draft: Record<string, Draft>,
): OverrideUpdate[] {
  const out: OverrideUpdate[] = [];
  for (const entry of entries) {
    const base = baseline.get(entry.key);
    const row = draft[entry.key];
    if (!base || !row) continue;
    const writeOnly = isSecretEntry(entry);

    if (!row.set) {
      if (base.set) out.push({ key: entry.key, state: "default" });
      continue;
    }

    const stateChanged = row.state !== base.state;
    const valueChanged = writeOnly
      ? typedSecret(row)
      : !sameValue(row.value, base.value);
    if (base.set && !stateChanged && !valueChanged) continue;

    const update: OverrideUpdate = { key: entry.key, state: row.state };
    if (writeOnly) {
      if (typedSecret(row)) update.value = row.value;
    } else {
      update.value = row.value;
    }
    out.push(update);
  }
  return out;
}

/** Does a freshly loaded payload already hold the draft (the refetch after our own save)? */
export function reflects(
  entries: ConfigEntry[],
  incoming: Map<string, Baseline>,
  draft: Record<string, Draft>,
): boolean {
  return entries.every((entry) => {
    const b = incoming.get(entry.key);
    const d = draft[entry.key];
    if (!b || !d) return true;
    if (!d.set) return !b.set;
    if (!b.set || b.state !== d.state) return false;
    if (isSecretEntry(entry)) return typedSecret(d) ? b.secretConfigured : true;
    return sameValue(b.value, d.value);
  });
}

/**
 * A row's problem, if any. Beyond the schema check there are two shapes the worker would
 * mis-store rather than reject: a set row with no value, and a brand-new secret with nothing
 * typed.
 */
function rowError(
  entry: ConfigEntry,
  base: Baseline,
  row: Draft,
  catalog: ReturnType<typeof useCatalog>,
): string | null {
  if (!row.set) return null;
  if (isSecretEntry(entry)) {
    if (!typedSecret(row)) {
      return base.secretConfigured
        ? null
        : "Enter a value for this secret, or remove the key.";
    }
    return validateEntry(entry, row.value, catalog);
  }
  if (row.value === undefined)
    return "Enter a value, or remove the key from the payload.";
  return validateEntry(entry, row.value, catalog);
}

/**
 * Split a worker `fields: string[]` into per-row messages plus whatever named no key. Each
 * catalog-validated string is `${key}${instancePath} ${message}`, so the longest key that
 * prefixes the string owns it (`audio` and `audio.buffer` can both be catalog keys).
 */
export function mapServerFields(
  fields: string[] | undefined,
  entries: ConfigEntry[],
): { byKey: Record<string, string>; rest: string[] } {
  const byKey: Record<string, string> = {};
  const rest: string[] = [];
  const keys = [...entries.map((e) => e.key)].sort(
    (a, b) => b.length - a.length,
  );
  for (const field of fields ?? []) {
    const hit = keys.find(
      (k) =>
        field === k || field.startsWith(`${k} `) || field.startsWith(`${k}/`),
    );
    if (hit) byKey[hit] = field.slice(hit.length).trimStart() || field;
    else rest.push(field);
  }
  return { byKey, rest };
}

/**
 * Form field names for catalog keys. A catalog key is dotted (`network.proxy.url`) and the form
 * library reads dots as nesting, so each key is stored under an escaped name.
 */
const fieldName = (key: string): string =>
  `k_${encodeURIComponent(key).replace(/\./g, "%2E")}`;

type Rows = Record<string, Draft>;

/** The synthetic trailing group for `ui.advanced` entries (MPE-4: never "Advanced"). */
export const MORE_SETTINGS = "More settings";

// ── the editor ─────────────────────────────────────────────────────────────────────────────────

export interface ManagedPayloadEditorProps {
  slug: string;
  catalog: ProductCatalog;
  payload: RedactedPayload;
  /**
   * What the layers BELOW this one contribute, per key. Only license overrides have any (the
   * catalog default → tier's profile → the license's profiles); a profile payload is itself a
   * layer, so it passes nothing.
   */
  inherited?: Record<string, InheritedValue>;
  saving?: boolean;
  /** `fields` from a 422 on the last save, matched back onto the rows that caused them. */
  serverFields?: string[];
  submitLabel?: string;
  /**
   * Save the batch. The draft stays until the refetch that follows a successful save shows the
   * server holding it, so a failed save (rejected or swallowed) never loses the operator's work.
   */
  onSubmit: (updates: OverrideUpdate[]) => void | Promise<void>;
  /** Told whenever the draft becomes dirty or clean (navigation guards, a tab's dirty dot). */
  onDirtyChange?: (dirty: boolean) => void;
}

/** Thrown into the form layer after a save so it never adopts the draft as the baseline itself. */
const AWAIT_REFETCH = new Error("awaiting the refetch that confirms the save");

export function ManagedPayloadEditor({
  slug,
  catalog,
  payload,
  inherited,
  saving = false,
  serverFields,
  submitLabel = "Save changes",
  onSubmit,
  onDirtyChange,
}: ManagedPayloadEditorProps): React.ReactElement {
  const compiled = useCatalog(catalog);
  const entries = React.useMemo(() => catalog.entries, [catalog]);
  const uid = React.useId().replace(/:/g, "");

  const serverRows = React.useMemo(() => {
    const rows: Rows = {};
    for (const entry of entries) {
      const b = baselineFor(entry, payload);
      rows[fieldName(entry.key)] = {
        set: b.set,
        value: b.value,
        state: b.state,
      };
    }
    return rows;
  }, [entries, payload]);

  // The server identity: the payload itself (stamps included, so replacing a stored secret still
  // counts as a change) and the catalog version.
  const identity = React.useMemo(
    () => JSON.stringify([catalog.schemaVersion, payload]),
    [catalog.schemaVersion, payload],
  );
  const submitRef = React.useRef<() => Promise<void>>(async () => undefined);
  const form = useAdminForm<{ rows: Rows }>({
    values: { rows: serverRows },
    resetOn: [identity],
    onSubmit: () => submitRef.current(),
    mapServerErrors: () => null,
  });

  // The stamps (updatedAt, a stored secret) of the payload the draft is compared against. It
  // follows the prop except while a server change is waiting on the operator's answer.
  const [baselinePayload, setBaselinePayload] = React.useState(payload);
  React.useEffect(() => {
    if (!form.serverChanged) setBaselinePayload(payload);
  }, [payload, form.serverChanged]);
  const baseline = React.useMemo(() => {
    const map = new Map<string, Baseline>();
    const rows = form.server.rows ?? {};
    for (const entry of entries) {
      const stamps = baselineFor(entry, baselinePayload);
      const row = rows[fieldName(entry.key)];
      map.set(
        entry.key,
        row
          ? { ...stamps, set: row.set, value: row.value, state: row.state }
          : stamps,
      );
    }
    return map;
  }, [entries, form.server, baselinePayload]);

  // The form library mutates its values object in place, so the draft is keyed on its content.
  const watched = form.rhf.watch("rows") as Rows | undefined;
  const watchedKey = JSON.stringify(watched ?? null);
  const draft = React.useMemo(() => {
    const out: Record<string, Draft> = {};
    for (const entry of entries) {
      const row = watched?.[fieldName(entry.key)];
      const base = baseline.get(entry.key)!;
      out[entry.key] = row ?? {
        set: base.set,
        value: base.value,
        state: base.state,
      };
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, watchedKey, baseline]);

  /** Errors the control itself reported (a JSON box that will not parse). */
  const [liveErrors, setLiveErrors] = React.useState<Record<string, string>>(
    {},
  );
  const [query, setQuery] = React.useState("");
  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({});
  const [reviewing, setReviewing] = React.useState(false);

  const updates = React.useMemo(
    () => diffPayload(entries, baseline, draft),
    [entries, baseline, draft],
  );
  const dirtyKeys = React.useMemo(
    () => new Set(updates.map((u) => u.key)),
    [updates],
  );
  const dirty = updates.length > 0;

  React.useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const incomingReflectsDraft = React.useMemo(
    () => reflects(entries, baselines(entries, payload), draft),
    [entries, payload, draft],
  );

  // The refetch after our own save: take it silently when it holds the draft (MPE-1).
  React.useEffect(() => {
    if (form.serverChanged && incomingReflectsDraft) {
      form.acceptServer();
      setLiveErrors({});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.serverChanged, incomingReflectsDraft]);

  // A row that no longer differs from the server keeps no live error.
  React.useEffect(() => {
    setLiveErrors((prev) => {
      const next = Object.fromEntries(
        Object.entries(prev).filter(([k]) => dirtyKeys.has(k)),
      );
      return Object.keys(next).length === Object.keys(prev).length
        ? prev
        : next;
    });
  }, [dirtyKeys]);

  // A server message belongs to the value it refused: once the operator edits that row, the
  // message no longer describes it (and must not keep blocking the save).
  const [refused, setRefused] = React.useState<Record<string, string>>({});
  React.useEffect(() => {
    const mapped = mapServerFields(serverFields, entries);
    setRefused(
      Object.fromEntries(
        Object.keys(mapped.byKey).map((k) => [k, JSON.stringify(draft[k])]),
      ),
    );
    // Snapshot the draft only when a new set of server messages arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverFields, entries]);

  const server = React.useMemo(() => {
    const mapped = mapServerFields(serverFields, entries);
    // A message for a row the operator has since unset has no control to sit under: show it at
    // batch level rather than dropping it (a swallowed 422 reads as a save that worked).
    const rest = [...mapped.rest];
    const byKey: Record<string, string> = {};
    for (const [key, message] of Object.entries(mapped.byKey)) {
      if (key in refused && refused[key] !== JSON.stringify(draft[key]))
        continue;
      if (draft[key]?.set) byKey[key] = message;
      else rest.push(`${key} ${message}`);
    }
    return { byKey, rest };
  }, [serverFields, entries, draft, refused]);

  /** Every row's problem (shown) and the changed rows' problems (blocking, MPE-2). */
  const { shown, blocking } = React.useMemo(() => {
    const shownMap: Record<string, string> = {};
    const blockingMap: Record<string, string> = {};
    for (const entry of entries) {
      const row = draft[entry.key];
      if (!row) continue;
      const changed = dirtyKeys.has(entry.key);
      const problem =
        server.byKey[entry.key] ??
        (changed ? liveErrors[entry.key] : undefined) ??
        rowError(entry, baseline.get(entry.key)!, row, compiled);
      if (!problem) continue;
      shownMap[entry.key] = problem;
      if (changed) blockingMap[entry.key] = problem;
    }
    return { shown: shownMap, blocking: blockingMap };
  }, [entries, draft, dirtyKeys, server.byKey, liveErrors, baseline, compiled]);
  const blockingKeys = Object.keys(blocking);
  const blocked = blockingKeys.length > 0;

  const setRow = (key: string, next: Partial<Draft>): void => {
    const current = draft[key];
    if (!current) return;
    form.rhf.setValue(
      `rows.${fieldName(key)}` as never,
      { ...current, ...next } as never,
      { shouldDirty: true },
    );
  };

  const setLive = (key: string, message: string | null): void =>
    setLiveErrors((prev) => {
      if (message === null) {
        if (!(key in prev)) return prev;
        const { [key]: _drop, ...rest } = prev;
        return rest;
      }
      if (prev[key] === message) return prev;
      return { ...prev, [key]: message };
    });

  const rowId = (key: string): string =>
    `pk-row-${uid}-${encodeURIComponent(key).replace(/[^\w-]/g, "_")}`;
  const groupOf = (key: string): string => {
    const entry = entries.find((e) => e.key === key);
    if (!entry) return "";
    return entry.ui?.advanced === true
      ? MORE_SETTINGS
      : entry.category || UNCATEGORISED;
  };

  const jumpTo = (key: string): void => {
    setReviewing(false);
    // A search that hides the row would leave nothing to jump to.
    setQuery("");
    setCollapsed((prev) => ({ ...prev, [groupOf(key)]: false }));
    window.setTimeout(() => {
      const el = document.getElementById(rowId(key));
      el?.scrollIntoView?.({ block: "center" });
      el?.querySelector<HTMLElement>(
        "input:not([type=hidden]):not([disabled]), textarea:not([disabled]), button[role=combobox], button[role=switch]",
      )?.focus();
    }, 0);
  };

  submitRef.current = async () => {
    if (blocked) {
      jumpTo(blockingKeys[0]!);
      throw AWAIT_REFETCH;
    }
    if (updates.length === 0) return;
    await onSubmit(updates);
    setReviewing(false);
    // Keep the draft until the refetch shows the server holding it (the effect above).
    throw AWAIT_REFETCH;
  };

  // ── search and grouping ──────────────────────────────────────────────────────────────────────
  const needle = query.trim().toLowerCase();
  const matches = React.useMemo(() => {
    if (!needle) return entries;
    return entries.filter((entry) => {
      const row = draft[entry.key];
      // MPE-4: the current value is searchable too (never a write-only one).
      const value =
        row?.set && !isSecretEntry(entry) ? formatValue(row.value) : "";
      return [
        entry.key,
        entry.label,
        entry.category,
        entry.description,
        entry.kind,
        value,
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [entries, needle, draft]);

  /** Advanced entries sink into their own trailing group rather than padding every category. */
  const groups = React.useMemo(() => {
    const plain = groupByCategory(
      matches.filter((e) => e.ui?.advanced !== true),
    );
    const advanced = groupByCategory(
      matches.filter((e) => e.ui?.advanced === true),
    ).flatMap((g) => g.entries);
    return advanced.length
      ? [...plain, { category: MORE_SETTINGS, entries: advanced }]
      : plain;
  }, [matches]);

  if (entries.length === 0) {
    return (
      <EmptyState
        kind="first-run"
        title="This product has no config catalog"
        description="Managed values are declared by the catalog. Publish a catalog version with config, secret or flag entries and they show up here."
        primaryAction={
          <Button asChild variant="outline">
            <Link to={r.catalog(slug)}>Open the catalog</Link>
          </Button>
        }
      />
    );
  }

  const setCount = entries.filter((e) => draft[e.key]?.set).length;
  const busy = saving || form.isSubmitting;
  const summary = (
    <span className="flex flex-wrap items-center gap-x-2">
      <span>
        {updates.length} unsaved {updates.length === 1 ? "change" : "changes"}
      </span>
      {blocked ? (
        <>
          <span className="text-danger">
            · fix {blockingKeys.length}{" "}
            {blockingKeys.length === 1 ? "error" : "errors"} to save
          </span>
          <Button
            variant="link"
            size="sm"
            iconStart={<ArrowDown aria-hidden />}
            onClick={() => jumpTo(blockingKeys[0]!)}
          >
            Jump to first error
          </Button>
        </>
      ) : null}
    </span>
  );

  return (
    <div className="space-y-4">
      {form.serverChanged && !incomingReflectsDraft ? (
        <Callout
          tone="warning"
          live
          title="This payload changed on the server while you were editing"
          action={
            <span className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  form.keepMine();
                  setBaselinePayload(payload);
                }}
              >
                Keep mine
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  form.acceptServer();
                  setLiveErrors({});
                }}
              >
                Take theirs
              </Button>
            </span>
          }
        >
          Keep mine compares your draft with the new values. Take theirs
          discards your draft.
        </Callout>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-56 flex-1">
          <Input
            type="search"
            value={query}
            aria-label="Search keys and values"
            placeholder="Search key, label, category or value…"
            prefix={<Search aria-hidden className="size-4" />}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <p className="text-sm text-fg-muted" aria-live="polite">
          {needle
            ? `${matches.length} of ${entries.length} entries`
            : `${setCount} of ${entries.length} entries set`}
        </p>
      </div>

      {matches.length === 0 ? (
        <EmptyState
          kind="no-results"
          title="No entries match this search"
          filters={`“${query.trim()}”`}
          onClearFilters={() => setQuery("")}
        />
      ) : (
        <div className="space-y-4">
          {groups.map((group, index) => {
            // A search is a request to see the matches, so it wins over a folded section.
            const open = needle !== "" || !collapsed[group.category];
            const bodyId = `pk-group-${uid}-${index}`;
            const groupSet = group.entries.filter(
              (e) => draft[e.key]?.set,
            ).length;
            const groupDirty = group.entries.filter((e) =>
              dirtyKeys.has(e.key),
            ).length;
            const groupErrors = group.entries.filter(
              (e) => shown[e.key],
            ).length;
            return (
              <section key={group.category} className="space-y-3">
                <h2>
                  <button
                    type="button"
                    aria-expanded={open}
                    aria-controls={bodyId}
                    onClick={() =>
                      setCollapsed((prev) => ({
                        ...prev,
                        [group.category]: !prev[group.category],
                      }))
                    }
                    className="flex w-full flex-wrap items-center gap-2 rounded-md px-1 py-1 text-left text-sm font-bold text-fg-strong focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus"
                  >
                    <ChevronDown
                      aria-hidden
                      className={cn(
                        "size-4 text-fg-muted transition-transform",
                        open ? "" : "-rotate-90",
                      )}
                    />
                    {categoryLabel(group.category)}
                    <StatusPill tone="neutral" icon={false} size="sm">
                      {groupSet}/{group.entries.length} set
                    </StatusPill>
                    {groupDirty > 0 ? (
                      <StatusPill tone="accent" icon={false} size="sm">
                        {groupDirty} changed
                      </StatusPill>
                    ) : null}
                    {groupErrors > 0 ? (
                      <StatusPill tone="danger" size="sm">
                        {groupErrors} {groupErrors === 1 ? "error" : "errors"}
                      </StatusPill>
                    ) : null}
                  </button>
                </h2>
                <div id={bodyId} hidden={!open} className="space-y-3">
                  {group.entries.map((entry) => {
                    const base = baseline.get(entry.key)!;
                    const row = draft[entry.key]!;
                    return (
                      <ManagedField
                        key={entry.key}
                        domId={rowId(entry.key)}
                        entry={entry}
                        catalog={compiled}
                        value={row.value}
                        state={row.state}
                        set={row.set}
                        dirty={dirtyKeys.has(entry.key)}
                        disabled={busy}
                        updatedAt={base.updatedAt || undefined}
                        secretConfigured={base.secretConfigured}
                        inherited={inherited?.[entry.key] ?? null}
                        error={shown[entry.key]}
                        onSetChange={(next) => {
                          setLive(entry.key, null);
                          setRow(entry.key, {
                            set: next,
                            // Materialising seeds from the catalog default so the operator edits
                            // a real value rather than a blank the server would reject.
                            value: next
                              ? base.set
                                ? base.value
                                : isSecretEntry(entry)
                                  ? undefined
                                  : initialValueFor(entry)
                              : base.value,
                            state: base.state,
                          });
                        }}
                        onValueChange={(result) => {
                          setRow(entry.key, { value: result.value });
                          setLive(
                            entry.key,
                            result.valid
                              ? null
                              : (result.error ?? "Invalid value"),
                          );
                        }}
                        onStateChange={(state) => setRow(entry.key, { state })}
                      />
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {server.rest.length > 0 ? (
        <Callout tone="danger" live title="The server rejected this batch">
          <ul className="list-disc pl-5">
            {server.rest.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </Callout>
      ) : null}

      {dirty ? (
        <SaveBar
          form={form}
          saveLabel={submitLabel}
          summary={summary}
          onReview={() => setReviewing(true)}
          reviewLabel="Review changes"
        />
      ) : null}

      <ReviewDrawer
        open={reviewing && dirty}
        onOpenChange={setReviewing}
        entries={entries}
        updates={updates}
        baseline={baseline}
        draft={draft}
        inherited={inherited}
        blocked={blocked}
        saving={busy}
        submitLabel={submitLabel}
        onSave={() => void form.submit()}
      />
    </div>
  );
}

// ── review (MPE-3) ─────────────────────────────────────────────────────────────────────────────

function describeRow(
  entry: ConfigEntry,
  row: { set: boolean; value: unknown; state: ManagementState },
  secretStored: boolean,
): string {
  if (!row.set) return "Not set";
  const shown = isSecretEntry(entry)
    ? typedSecret(row)
      ? "a new secret"
      : secretStored
        ? "the stored secret"
        : "—"
    : formatValue(row.value);
  return `${shown} · ${MANAGEMENT_LABELS[row.state] ?? row.state}`;
}

function ReviewDrawer({
  open,
  onOpenChange,
  entries,
  updates,
  baseline,
  draft,
  inherited,
  blocked,
  saving,
  submitLabel,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entries: ConfigEntry[];
  updates: OverrideUpdate[];
  baseline: Map<string, Baseline>;
  draft: Record<string, Draft>;
  inherited?: Record<string, InheritedValue>;
  blocked: boolean;
  saving: boolean;
  submitLabel: string;
  onSave: () => void;
}): React.ReactElement {
  const byKey = new Map(entries.map((e) => [e.key, e]));
  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      dismissible={!saving}
      size="lg"
      title="Review changes"
      description={`${updates.length} ${updates.length === 1 ? "key changes" : "keys change"} when you save.`}
    >
      <DrawerBody>
        <ul className="space-y-2" aria-label="Changes">
          {updates.map((u) => {
            const entry = byKey.get(u.key)!;
            const base = baseline.get(u.key)!;
            const row = draft[u.key]!;
            const below = inherited?.[u.key];
            const fallback = entryDefault(entry);
            // A row left at Default under a lower lock is ignored (the Worker's `mergeMap`).
            const lockedBelow =
              below !== undefined &&
              below.state !== "default" &&
              row.state === "default";
            const effective = !row.set
              ? below
                ? `${formatValue(below.value)} (from ${below.source}${lockedBelow ? ", locked" : ""})`
                : fallback !== undefined
                  ? `${formatValue(fallback)} (the catalog default)`
                  : "nothing: no layer sets this key"
              : lockedBelow
                ? `${formatValue(below.value)} (enforced by ${below.source})`
                : isSecretEntry(entry)
                  ? "the secret (write-only)"
                  : formatValue(row.value);
            return (
              <li
                key={u.key}
                className="rounded-md border border-border bg-surface-raised px-3 py-2 text-sm"
              >
                <p className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-bold text-fg-strong">
                    {entry.label}
                  </span>
                  <code className="font-mono text-xs text-fg-muted">
                    {u.key}
                  </code>
                </p>
                <dl className="mt-1 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
                  <dt className="text-fg-muted">Before</dt>
                  <dd className="break-words font-mono">
                    {describeRow(entry, base, base.secretConfigured)}
                  </dd>
                  <dt className="text-fg-muted">After</dt>
                  <dd className="break-words font-mono text-fg-strong">
                    {describeRow(entry, row, base.secretConfigured)}
                  </dd>
                  <dt className="text-fg-muted">Effective</dt>
                  <dd className="break-words font-mono">{effective}</dd>
                </dl>
              </li>
            );
          })}
        </ul>
      </DrawerBody>
      <DrawerFooter>
        <Button
          variant="ghost"
          disabled={saving}
          onClick={() => onOpenChange(false)}
        >
          Back to editing
        </Button>
        <Button
          loading={saving}
          disabledReason={
            blocked ? "Fix the highlighted errors first." : undefined
          }
          onClick={onSave}
        >
          {submitLabel}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}
