import * as React from "react";
import { ChevronDown, FileJson, Save, Search, Undo2 } from "lucide-react";
import type {
  ConfigEntry,
  ManagedEntry,
  ManagedSecretView,
  ManagementState,
  OverrideUpdate,
  ProductCatalog,
  RedactedPayload,
} from "./api.js";
import { hashFor } from "./route.js";
import { cn } from "./lib/cn.js";
import { docsUrl } from "./lib/docsLinks.js";
import {
  ManagedField,
  initialValueFor,
  isSecretEntry,
  useCatalog,
  validateEntry,
  type InheritedValue,
} from "./SchemaForm.js";
import { Badge, Button, EmptyState, Input } from "./components/ui/index.js";
import { groupByCategory } from "./views/catalog/helpers.js";

/**
 * The managed-payload editor — ONE component behind both catalog-driven editing surfaces:
 * a profile's payload (`views/profiles/PayloadEditor`) and a license's overrides
 * (`views/licenses/OverridesEditor`). They differ only in what they do with the batch and in
 * whether a lower layer of the stack has anything to say, so they differ only by props.
 *
 * WHY ONE COMPONENT. The two screens drifted: one grouped by category into tabs, the other
 * rendered a flat list of `Card`s; one showed "secret set", the other "configured"; neither
 * could tell an operator whether a key was *absent* or merely blank. Everything below —
 * grouping, search, set-vs-unset, inline validation, the dirty bar — has to be true on both
 * screens or neither, which is an argument for one implementation, not two that agree today.
 *
 * ── THE THREE THINGS THIS GETS RIGHT ─────────────────────────────────────────────────────────
 *
 * 1. SET IS NOT THE SAME AS BLANK. `applyOverrides` (worker) deletes a key whose update carries
 *    no value and state `default`, and writes one otherwise. So a payload key is present or
 *    absent, and the editor models exactly that: absent rows read "Not set" with the fallback
 *    ghosted, ✕ returns a row to absent, and no code path ever sends `""` to mean "unset".
 * 2. VALIDATION IS THE SERVER'S. Every value goes through `Catalog#validateEntryValue` — the
 *    same call the PUT handler makes — so Save is disabled on exactly the batches the worker
 *    would 422, and the inline message is the message the 422 would have carried.
 * 3. A 422 LANDS ON A ROW. The worker returns `fields: string[]`, each prefixed with the dotted
 *    key it concerns (`"audio.buffer must be >= 128"`). Those are matched back to rows rather
 *    than flattened into a toast that names no control.
 */

// ── working state ────────────────────────────────────────────────────────────

/** What the server currently holds for one key. */
interface Baseline {
  /** Is the key present in this payload at all? */
  set: boolean;
  value: unknown;
  state: ManagementState;
  updatedAt: number;
  /** A write-only entry with a stored value. Its value is never on the wire, so never shown. */
  secretConfigured: boolean;
}

/** What the operator has the row at right now. */
interface Draft {
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
  // redacted to `value: ""` (worker `admin/lib/redact.ts`). Treat it as write-only: rendering
  // that `""` would tell the operator the stored secret is an empty string.
  const writeOnly = isSecretEntry(entry);
  return {
    set: m !== undefined,
    value: writeOnly ? undefined : m?.value,
    state: m?.state ?? fallbackState,
    updatedAt: m?.updatedAt ?? 0,
    secretConfigured: writeOnly && m !== undefined,
  };
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

/**
 * The minimal batch between the loaded payload and the draft.
 *
 * A set row ALWAYS carries its value, even when only the state moved. `applyOverrides` reads a
 * value-less update with state `default` as "delete this key" — so a state-only demotion to
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
      // Absent, and it used to be there ⇒ clear it. No value + state `default` is the worker's
      // delete, which is why "unset" never needs a sentinel value.
      if (base.set) out.push({ key: entry.key, state: "default" });
      continue;
    }

    const stateChanged = row.state !== base.state;
    const typedSecret =
      writeOnly && row.value !== undefined && row.value !== "";
    const valueChanged = writeOnly
      ? typedSecret
      : !sameValue(row.value, base.value);
    if (base.set && !stateChanged && !valueChanged) continue;

    const update: OverrideUpdate = { key: entry.key, state: row.state };
    if (writeOnly) {
      if (typedSecret) update.value = row.value;
    } else {
      update.value = row.value;
    }
    out.push(update);
  }
  return out;
}

/**
 * A row's blocking problem, if any. Beyond the schema check there are two shapes the worker
 * would mis-store rather than reject: a set row with no value at all (`nextValue` falls through
 * to the stored value, or to `true`), and a brand-new secret with nothing typed (same).
 */
function rowError(
  entry: ConfigEntry,
  base: Baseline,
  row: Draft,
  catalog: ReturnType<typeof useCatalog>,
): string | null {
  if (!row.set) return null;
  if (isSecretEntry(entry)) {
    if (row.value === undefined || row.value === "") {
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
 * catalog-validated string is `` `${key}${instancePath} ${message}` `` (`shared-catalog`
 * `Catalog#validateEntryValue`), so the longest key that prefixes the string owns it — longest,
 * because `audio` and `audio.buffer` can both be catalog keys.
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

// ── the editor ───────────────────────────────────────────────────────────────

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
  /** `fields` from a 422 on the last save — matched back onto the rows that caused it. */
  serverFields?: string[];
  submitLabel?: string;
  onSubmit: (updates: OverrideUpdate[]) => void | Promise<void>;
}

export function ManagedPayloadEditor({
  slug,
  catalog,
  payload,
  inherited,
  saving = false,
  serverFields,
  submitLabel = "Save changes",
  onSubmit,
}: ManagedPayloadEditorProps): React.ReactElement {
  const compiled = useCatalog(catalog);
  const entries = React.useMemo(() => catalog.entries, [catalog]);

  const baseline = React.useMemo(() => {
    const map = new Map<string, Baseline>();
    for (const entry of entries)
      map.set(entry.key, baselineFor(entry, payload));
    return map;
  }, [entries, payload]);

  const seed = React.useMemo(() => {
    const map: Record<string, Draft> = {};
    for (const entry of entries) {
      const b = baseline.get(entry.key)!;
      map[entry.key] = { set: b.set, value: b.value, state: b.state };
    }
    return map;
  }, [entries, baseline]);

  const [draft, setDraft] = React.useState<Record<string, Draft>>(seed);
  /** Errors the control itself reported (a JSON textarea that will not parse). */
  const [liveErrors, setLiveErrors] = React.useState<Record<string, string>>(
    {},
  );
  const [query, setQuery] = React.useState("");
  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({});

  // Re-seed when a fresh payload lands (a save + invalidate, a product switch).
  React.useEffect(() => {
    setDraft(seed);
    setLiveErrors({});
  }, [seed]);

  const updates = React.useMemo(
    () => diffPayload(entries, baseline, draft),
    [entries, baseline, draft],
  );
  const dirtyKeys = React.useMemo(
    () => new Set(updates.map((u) => u.key)),
    [updates],
  );

  const server = React.useMemo(() => {
    const mapped = mapServerFields(serverFields, entries);
    // A message for a row the operator has since unset has no control to sit under. Show it at
    // batch level rather than dropping it — a swallowed 422 reads as a save that worked.
    const rest = [...mapped.rest];
    const byKey: Record<string, string> = {};
    for (const [key, message] of Object.entries(mapped.byKey)) {
      if (draft[key]?.set) byKey[key] = message;
      else rest.push(`${key} ${message}`);
    }
    return { byKey, rest };
  }, [serverFields, entries, draft]);

  const errors = React.useMemo(() => {
    const map: Record<string, string> = {};
    for (const entry of entries) {
      const base = baseline.get(entry.key)!;
      const row = draft[entry.key];
      if (!row) continue;
      const problem =
        liveErrors[entry.key] ?? rowError(entry, base, row, compiled);
      if (problem) map[entry.key] = problem;
    }
    return map;
  }, [entries, baseline, draft, liveErrors, compiled]);

  const blocked = Object.keys(errors).length > 0;

  const patch = (key: string, next: Partial<Draft>): void =>
    setDraft((prev) => {
      const current = prev[key];
      if (!current) return prev;
      return { ...prev, [key]: { ...current, ...next } };
    });

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

  const discard = (): void => {
    setDraft(seed);
    setLiveErrors({});
  };

  // ── filtering + grouping ───────────────────────────────────────────────────
  const needle = query.trim().toLowerCase();
  const matches = React.useMemo(() => {
    if (!needle) return entries;
    return entries.filter((entry) =>
      [entry.key, entry.label, entry.category, entry.description, entry.kind]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }, [entries, needle]);

  /** Advanced entries sink into their own trailing group rather than padding every category. */
  const groups = React.useMemo(() => {
    const plain = groupByCategory(
      matches.filter((e) => e.ui?.advanced !== true),
    );
    const advanced = groupByCategory(
      matches.filter((e) => e.ui?.advanced === true),
    ).flatMap((g) => g.entries);
    return advanced.length
      ? [...plain, { category: "Advanced", entries: advanced }]
      : plain;
  }, [matches]);

  if (entries.length === 0) {
    return (
      <EmptyState
        icon={<FileJson aria-hidden />}
        title="This product has no config catalog"
        description="Managed values are declared by the catalog. Publish a catalog version with config, secret, or flag entries and they show up here."
        action={
          <Button asChild variant="outline">
            <a href={hashFor({ kind: "product", slug, view: "config" })}>
              Go to Config → Catalog
            </a>
          </Button>
        }
      />
    );
  }

  const setCount = entries.filter((e) => draft[e.key]?.set).length;

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (blocked || updates.length === 0) return;
        void onSubmit(updates);
      }}
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-56 flex-1">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            className="pl-8"
            value={query}
            aria-label="Filter keys"
            placeholder="Filter by key, label, or category…"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {needle
            ? `${matches.length} of ${entries.length} entries`
            : `${setCount} of ${entries.length} entries set`}
        </p>
        <a
          className="text-sm underline underline-offset-2 text-muted-foreground hover:text-foreground"
          href={docsUrl("managedPayloads")}
          target="_blank"
          rel="noreferrer"
        >
          Learn more
        </a>
      </div>

      {matches.length === 0 ? (
        <EmptyState
          icon={<Search aria-hidden />}
          title="No entries match this filter"
          description={`Nothing in this catalog matches “${query.trim()}”.`}
          action={
            // `type` is load-bearing: `Button` has no default, so a bare button inside this
            // form would submit the batch instead of clearing the filter.
            <Button
              type="button"
              variant="outline"
              onClick={() => setQuery("")}
            >
              Clear filter
            </Button>
          }
        />
      ) : (
        <div className="space-y-4">
          {groups.map((group) => {
            // A filter is a request to see the matches, so it wins over a folded section.
            const open = needle !== "" || !collapsed[group.category];
            const bodyId = `pk-group-${group.category.replace(/\W+/g, "-")}`;
            const groupSet = group.entries.filter(
              (e) => draft[e.key]?.set,
            ).length;
            const groupDirty = group.entries.filter((e) =>
              dirtyKeys.has(e.key),
            ).length;
            return (
              <section key={group.category} className="space-y-3">
                <h3>
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
                    className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-sm font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <ChevronDown
                      aria-hidden
                      className={cn(
                        "size-4 transition-transform",
                        open ? "" : "-rotate-90",
                      )}
                    />
                    {group.category}
                    <Badge variant="outline">
                      {groupSet}/{group.entries.length} set
                    </Badge>
                    {groupDirty > 0 ? (
                      <Badge variant="primary">{groupDirty} changed</Badge>
                    ) : null}
                  </button>
                </h3>
                <div id={bodyId} hidden={!open} className="space-y-3">
                  {group.entries.map((entry) => {
                    const base = baseline.get(entry.key)!;
                    const row = draft[entry.key]!;
                    return (
                      <ManagedField
                        key={entry.key}
                        entry={entry}
                        catalog={compiled}
                        value={row.value}
                        state={row.state}
                        set={row.set}
                        dirty={dirtyKeys.has(entry.key)}
                        disabled={saving}
                        updatedAt={base.updatedAt || undefined}
                        secretConfigured={base.secretConfigured}
                        inherited={inherited?.[entry.key] ?? null}
                        error={server.byKey[entry.key] ?? errors[entry.key]}
                        onSetChange={(next) => {
                          setLive(entry.key, null);
                          patch(entry.key, {
                            set: next,
                            // Materialising seeds from the catalog default so the operator is
                            // editing a real value rather than a blank the server would reject.
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
                          patch(entry.key, { value: result.value });
                          setLive(
                            entry.key,
                            result.valid
                              ? null
                              : (result.error ?? "Invalid value"),
                          );
                        }}
                        onStateChange={(state) => patch(entry.key, { state })}
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
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
        >
          <p className="font-medium">The server rejected this batch:</p>
          <ul className="mt-1 list-disc pl-5">
            {server.rest.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* The bar only exists while there is something to save — a permanently-parked footer
          reads as chrome, and an operator stops seeing it. */}
      {updates.length > 0 ? (
        <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center gap-3 border-t border-border bg-background/95 px-1 py-3 backdrop-blur-sm">
          <p
            className="mr-auto text-sm font-medium"
            role="status"
            aria-live="polite"
          >
            {updates.length} unsaved{" "}
            {updates.length === 1 ? "change" : "changes"}
            {blocked ? (
              <span className="ml-2 font-normal text-destructive">
                — fix {Object.keys(errors).length}{" "}
                {Object.keys(errors).length === 1 ? "error" : "errors"} to save
              </span>
            ) : null}
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={saving}
            onClick={discard}
          >
            <Undo2 aria-hidden />
            Discard
          </Button>
          <Button type="submit" loading={saving} disabled={blocked}>
            <Save aria-hidden />
            {submitLabel}
          </Button>
        </div>
      ) : null}
    </form>
  );
}
