import * as React from "react";
import { AlertTriangle, Save } from "lucide-react";
import {
  api,
  ApiError,
  type ConfigEntry,
  type ManagementState,
  type OverrideUpdate,
  type ProductCatalog,
  type ProfileDetail,
  type RedactedPayload,
} from "../../api.js";
import { invalidate, useResource } from "../../context.js";
import { ManagedField } from "../../SchemaForm.js";
import {
  Badge,
  Button,
  EmptyState,
  Skeleton,
  useToast,
} from "../../components/ui/index.js";

/**
 * The per-key working state for one managed entry. `secret` entries never carry a value over the
 * wire (write-only), so the value box stays empty unless an admin types a new secret to set.
 */
interface KeyState {
  state: ManagementState;
  value: unknown;
  updatedAt: number;
  /** A secret already has a configured value on the server (value withheld). */
  secretConfigured: boolean;
  /** Whether this is a write-only secret entry. */
  isSecret: boolean;
}

/** Pull the merged `{config, secrets, entitlements}` payload into a flat per-key map. */
function seedFromPayload(payload: RedactedPayload, entries: ConfigEntry[]): Record<string, KeyState> {
  const out: Record<string, KeyState> = {};
  for (const entry of entries) {
    const isSecret = entry.kind === "secret" || entry.secret === true;
    if (isSecret) {
      const v = payload.secrets[entry.key];
      out[entry.key] = {
        state: v?.state ?? entry.managementDefault ?? "default",
        value: "",
        updatedAt: v?.updatedAt ?? 0,
        secretConfigured: v?.configured ?? false,
        isSecret: true,
      };
      continue;
    }
    const bag = entry.kind === "flag" ? payload.entitlements : payload.config;
    const v = bag[entry.key];
    out[entry.key] = {
      state: v?.state ?? entry.managementDefault ?? "default",
      value: v?.value,
      updatedAt: v?.updatedAt ?? 0,
      secretConfigured: false,
      isSecret: false,
    };
  }
  return out;
}

const CATEGORY_ORDER = (entry: ConfigEntry): number => entry.ui?.order ?? 0;

/**
 * The managed-payload editor for a single profile. Loads the product catalog (schema) and renders
 * a `ManagedField` per entry, seeded from the profile's redacted payload, then diffs the working
 * state against the seed and PUTs only the changed keys via `putProfilePayload`. Secrets are
 * write-only: their value box starts empty and only sends when an admin types a replacement.
 */
export function PayloadEditor({ slug, profile }: { slug: string; profile: ProfileDetail }): React.ReactElement {
  const toast = useToast();
  const schemaRes = useResource<ProductCatalog>(`schema:${slug}`, () => api.schema(slug));
  const entries = React.useMemo(() => {
    const list = schemaRes.data?.entries ?? [];
    return [...list].sort((a, b) => CATEGORY_ORDER(a) - CATEGORY_ORDER(b));
  }, [schemaRes.data]);

  const seed = React.useMemo(() => seedFromPayload(profile.payload, entries), [profile.payload, entries]);
  const [state, setState] = React.useState<Record<string, KeyState>>(seed);
  const [saving, setSaving] = React.useState(false);

  // Re-seed when the profile or catalog changes (e.g. after a save + invalidate reload).
  React.useEffect(() => setState(seed), [seed]);

  const updates = React.useMemo(() => diff(seed, state, entries), [seed, state, entries]);
  const dirty = updates.length > 0;

  const setKey = (key: string, patch: Partial<KeyState>): void =>
    setState((prev) => {
      const current = prev[key];
      if (!current) return prev;
      return { ...prev, [key]: { ...current, ...patch } };
    });

  const handleSave = async (): Promise<void> => {
    if (!dirty) return;
    setSaving(true);
    try {
      await api.putProfilePayload(slug, profile.id, updates);
      toast.success("Payload saved", `Updated ${updates.length} ${updates.length === 1 ? "key" : "keys"}.`);
      invalidate(`profile:${slug}:${profile.id}`);
    } catch (err) {
      toast.error("Could not save payload", describeError(err));
    } finally {
      setSaving(false);
    }
  };

  const reset = (): void => setState(seed);

  if (schemaRes.loading && entries.length === 0) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-28 w-full" />
        ))}
      </div>
    );
  }

  if (schemaRes.error) {
    return (
      <EmptyState
        icon={<AlertTriangle aria-hidden />}
        title="Could not load the catalog"
        description={schemaRes.error}
        action={
          <Button variant="outline" onClick={schemaRes.reload}>
            Retry
          </Button>
        }
      />
    );
  }

  if (entries.length === 0) {
    return (
      <EmptyState
        title="No managed keys"
        description="This product's catalog has no config, secret, or flag entries to manage yet."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-4">
        {entries.map((entry) => {
          const ks = state[entry.key];
          if (!ks) return null;
          return (
            <div key={entry.key} className="space-y-1">
              {ks.isSecret && ks.secretConfigured ? (
                <p className="text-xs text-muted-foreground">
                  <Badge variant="warning">secret set</Badge> A value is configured. Type to replace it; leave blank to keep.
                </p>
              ) : null}
              <ManagedField
                entry={entry}
                value={ks.value}
                state={ks.state}
                updatedAt={ks.updatedAt || undefined}
                onValueChange={(r) => setKey(entry.key, { value: r.value })}
                onStateChange={(s) => setKey(entry.key, { state: s })}
              />
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
        <span className="mr-auto text-sm text-muted-foreground" role="status" aria-live="polite">
          {dirty ? `${updates.length} unsaved ${updates.length === 1 ? "change" : "changes"}` : "All changes saved"}
        </span>
        <Button variant="outline" disabled={!dirty || saving} onClick={reset}>
          Reset
        </Button>
        <Button loading={saving} disabled={!dirty} onClick={() => void handleSave()}>
          <Save aria-hidden />
          Save payload
        </Button>
      </div>
    </div>
  );
}

/** Compute the minimal `OverrideUpdate[]` between the seeded and the working state. */
function diff(
  seed: Record<string, KeyState>,
  current: Record<string, KeyState>,
  entries: ConfigEntry[],
): OverrideUpdate[] {
  const out: OverrideUpdate[] = [];
  for (const entry of entries) {
    const key = entry.key;
    const a = seed[key];
    const b = current[key];
    if (!a || !b) continue;
    const stateChanged = a.state !== b.state;
    // Secrets: a value change only counts when the admin typed a non-empty replacement.
    const valueChanged = b.isSecret
      ? typeof b.value === "string" && b.value !== ""
      : !sameValue(a.value, b.value);
    if (!stateChanged && !valueChanged) continue;
    const update: OverrideUpdate = { key };
    if (stateChanged) update.state = b.state;
    if (valueChanged) update.value = b.value;
    out.push(update);
  }
  return out;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // Treat undefined/null/"" as equivalent "no value" so re-seeds don't spuriously dirty.
  const empty = (v: unknown): boolean => v === undefined || v === null || v === "";
  if (empty(a) && empty(b)) return true;
  return false;
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.fields?.length) return `Check: ${err.fields.join(", ")}.`;
    return err.message || `Request failed (${err.status}).`;
  }
  return err instanceof Error ? err.message : "Request failed.";
}
