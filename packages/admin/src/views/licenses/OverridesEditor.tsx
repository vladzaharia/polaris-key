import * as React from "react";
import type {
  ConfigEntry,
  ManagedEntry,
  ManagedSecretView,
  ManagementState,
  OverrideUpdate,
  ProductCatalog,
  RedactedPayload,
} from "../../api.js";
import { ManagedField } from "../../SchemaForm.js";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
} from "../../components/ui/index.js";
import { formatStamp } from "./shared.js";

/**
 * The catalog-driven per-license override editor. It joins the product catalog (the set of
 * configurable keys + their JSON-Schema) with the license's redacted payload (current value +
 * management state + `updatedAt`) and lets an admin set each key's value and management state
 * (default / enforced / hidden). On submit it diffs against the loaded baseline and PUTs only
 * the changed keys as an `OverrideUpdate[]` batch.
 *
 * Secrets are write-only: the wire never carries their value, so we only edit the *state* of an
 * already-configured secret (or write a brand-new value), and surface whether one is configured.
 */

type Draft = { value: unknown; state: ManagementState };

function baselineFor(
  entry: ConfigEntry,
  payload: RedactedPayload,
): { state: ManagementState; value: unknown; updatedAt: number; configured?: boolean; modifiedBy?: string } {
  const fallbackState = entry.managementDefault ?? "default";
  if (entry.kind === "secret") {
    const s: ManagedSecretView | undefined = payload.secrets[entry.key];
    return { state: s?.state ?? fallbackState, value: undefined, updatedAt: s?.updatedAt ?? 0, configured: s?.configured ?? false };
  }
  const bucket = entry.kind === "flag" ? payload.entitlements : payload.config;
  const m: ManagedEntry | undefined = bucket[entry.key];
  return {
    state: m?.state ?? fallbackState,
    value: m?.value,
    updatedAt: m?.updatedAt ?? 0,
    modifiedBy: (m as ManagedEntry & { modifiedBy?: string } | undefined)?.modifiedBy,
  };
}

export function OverridesEditor({
  catalog,
  payload,
  saving,
  onSubmit,
}: {
  catalog: ProductCatalog;
  payload: RedactedPayload;
  saving?: boolean;
  onSubmit: (updates: OverrideUpdate[]) => void | Promise<void>;
}): React.ReactElement {
  // Stable baseline keyed off the loaded payload so re-renders don't clobber edits.
  const baseline = React.useMemo(() => {
    const map = new Map<string, ReturnType<typeof baselineFor>>();
    for (const entry of catalog.entries) map.set(entry.key, baselineFor(entry, payload));
    return map;
  }, [catalog, payload]);

  const initialDraft = React.useMemo(() => {
    const map: Record<string, Draft> = {};
    for (const entry of catalog.entries) {
      const b = baseline.get(entry.key)!;
      map[entry.key] = { value: b.value, state: b.state };
    }
    return map;
  }, [catalog, baseline]);

  const [draft, setDraft] = React.useState<Record<string, Draft>>(initialDraft);
  // Re-seed when a fresh payload arrives (after a save invalidates + reloads).
  React.useEffect(() => setDraft(initialDraft), [initialDraft]);

  const sorted = React.useMemo(
    () =>
      [...catalog.entries].sort(
        (a, b) => (a.ui?.order ?? 0) - (b.ui?.order ?? 0) || a.label.localeCompare(b.label),
      ),
    [catalog],
  );

  const dirty = React.useMemo(() => {
    const updates: OverrideUpdate[] = [];
    for (const entry of sorted) {
      const b = baseline.get(entry.key)!;
      const d = draft[entry.key];
      if (!d) continue;
      const stateChanged = d.state !== b.state;
      // Secrets are write-only — a value change means "set a new secret"; an empty value is no-op.
      const valueChanged =
        entry.kind === "secret"
          ? d.value !== undefined && d.value !== ""
          : JSON.stringify(d.value ?? null) !== JSON.stringify(b.value ?? null);
      if (!stateChanged && !valueChanged) continue;
      const update: OverrideUpdate = { key: entry.key };
      if (stateChanged) update.state = d.state;
      if (valueChanged) update.value = d.value;
      updates.push(update);
    }
    return updates;
  }, [sorted, baseline, draft]);

  const setValue = (key: string, value: unknown): void =>
    setDraft((prev) => {
      const current = prev[key] ?? { value: undefined, state: "default" };
      return { ...prev, [key]: { ...current, value } };
    });
  const setState = (key: string, state: ManagementState): void =>
    setDraft((prev) => {
      const current = prev[key] ?? { value: undefined, state: "default" };
      return { ...prev, [key]: { ...current, state } };
    });
  const reset = (): void => setDraft(initialDraft);

  if (sorted.length === 0) {
    return (
      <EmptyState
        title="No configurable keys"
        description="This product's catalog has no config, secret, or flag entries to override."
      />
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit(dirty);
      }}
      className="space-y-4"
    >
      <div className="space-y-3">
        {sorted.map((entry) => {
          const b = baseline.get(entry.key)!;
          const d = draft[entry.key]!;
          return (
            <Card key={entry.key}>
              <CardHeader className="pb-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="font-mono text-sm">{entry.key}</CardTitle>
                  <div className="flex items-center gap-2">
                    {entry.kind === "secret" ? (
                      <Badge variant={b.configured ? "success" : "outline"}>
                        {b.configured ? "configured" : "not set"}
                      </Badge>
                    ) : null}
                    <Badge variant="outline">{entry.category}</Badge>
                  </div>
                </div>
                {entry.description ? <CardDescription>{entry.description}</CardDescription> : null}
              </CardHeader>
              <CardContent className="space-y-2 pt-0">
                <ManagedField
                  entry={entry}
                  value={d.value}
                  state={d.state}
                  updatedAt={b.updatedAt}
                  onValueChange={(r) => setValue(entry.key, r.value)}
                  onStateChange={(s) => setState(entry.key, s)}
                />
                {b.modifiedBy || b.updatedAt ? (
                  <p className="text-xs text-muted-foreground">
                    {b.modifiedBy ? `Last changed by ${b.modifiedBy}` : "Last changed"}
                    {b.updatedAt ? ` · ${formatStamp(b.updatedAt)}` : ""}
                  </p>
                ) : null}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div className="flex items-center justify-end gap-2">
        <span className="mr-auto text-sm text-muted-foreground" aria-live="polite">
          {dirty.length === 0 ? "No pending changes" : `${dirty.length} pending change${dirty.length === 1 ? "" : "s"}`}
        </span>
        <Button type="button" variant="outline" disabled={saving || dirty.length === 0} onClick={reset}>
          Reset
        </Button>
        <Button type="submit" loading={saving} disabled={dirty.length === 0}>
          Save overrides
        </Button>
      </div>
    </form>
  );
}
