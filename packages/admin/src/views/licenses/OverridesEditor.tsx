import * as React from "react";
import type {
  ConfigEntry,
  ManagementState,
  OverrideUpdate,
  ProductCatalog,
  RedactedPayload,
} from "../../api.js";
import { ManagedPayloadEditor } from "../../ManagedPayloadEditor.js";
import {
  entryDefault,
  isSecretEntry,
  type InheritedValue,
} from "../../SchemaForm.js";

/**
 * The per-license override editor. It is the shared `ManagedPayloadEditor` plus one thing only
 * a license has: the LAYER STACK underneath it.
 *
 * ── WHAT "INHERITED" MEANS HERE ──────────────────────────────────────────────────────────────
 *
 * `GET …/license/licenses/<id>` returns `overrides` = the license row's own `overrides_json`,
 * and nothing else — no tier, no profile, no catalog defaults (worker `services/license/admin/
 * licenses.ts`). The merged result is only ever assembled at document-signing time
 * (`core/payload.ts#resolveMergedPayload`) and no admin endpoint exposes it. So an operator
 * looking at this tab could see "not set" on a key that is, in fact, firmly set one layer down —
 * which is the difference between "the app ignores my value" and "the app never had one".
 *
 * The console therefore rebuilds the layers below, in the server's own order and with the
 * server's own precedence rule, from data it can already fetch:
 *
 *     catalog default  <  the tier's profile  <  the license's profiles, in order  <  (this row)
 *
 * and `mergePayloads`' one exception: a lower `enforced`/`hidden` entry is NOT demoted by a
 * higher `default` one. `LicenseDetail` fetches the profile payloads and passes them in; a
 * product with no tier and no profiles simply contributes the catalog defaults, and the fetch
 * never happens.
 */

/** One layer of the stack, lowest first. */
export interface PayloadLayer {
  /** Human source, e.g. `profile “base”`. Rendered verbatim in the row. */
  source: string;
  payload: RedactedPayload;
}

function readLayer(
  entry: ConfigEntry,
  payload: RedactedPayload,
): { value: unknown; state: ManagementState } | null {
  if (entry.kind === "secret") {
    const s = payload.secrets[entry.key];
    // A secret's value never crosses the wire; all a lower layer can contribute is "there is
    // one, and this is how it is managed".
    return s
      ? { value: s.configured ? "(configured)" : undefined, state: s.state }
      : null;
  }
  const bucket = entry.kind === "flag" ? payload.entitlements : payload.config;
  const m = bucket[entry.key];
  if (!m) return null;
  return {
    value: isSecretEntry(entry) ? "(configured)" : m.value,
    state: m.state,
  };
}

/**
 * Collapse the layers below this license into one "what you would get without an override"
 * answer per key, using `merge.ts`' precedence: the higher layer wins, EXCEPT that it cannot
 * demote a lower `enforced`/`hidden` to `default`.
 */
export function resolveInherited(
  entries: readonly ConfigEntry[],
  layers: PayloadLayer[],
): Record<string, InheritedValue> {
  const out: Record<string, InheritedValue> = {};
  for (const entry of entries) {
    const fallback = entryDefault(entry);
    let current: InheritedValue | null =
      fallback === undefined
        ? null
        : {
            source: "the catalog default",
            value: fallback,
            state: entry.managementDefault ?? "default",
          };
    for (const layer of layers) {
      const found = readLayer(entry, layer.payload);
      if (!found) continue;
      const locked =
        current !== null &&
        current.state !== "default" &&
        found.state === "default";
      current = {
        source: layer.source,
        value: found.value,
        state: locked ? current!.state : found.state,
      };
    }
    if (current) out[entry.key] = current;
  }
  return out;
}

export function OverridesEditor({
  slug,
  catalog,
  payload,
  layers,
  saving,
  serverFields,
  onSubmit,
}: {
  /** Product slug — the editor's "no catalog" state links to Config → Catalog. */
  slug: string;
  catalog: ProductCatalog;
  payload: RedactedPayload;
  /** The layers below this license, lowest first. Omitted ⇒ only catalog defaults are shown. */
  layers?: PayloadLayer[];
  saving?: boolean;
  serverFields?: string[];
  onSubmit: (updates: OverrideUpdate[]) => void | Promise<void>;
}): React.ReactElement {
  const inherited = React.useMemo(
    () => resolveInherited(catalog.entries, layers ?? []),
    [catalog, layers],
  );

  return (
    <ManagedPayloadEditor
      slug={slug}
      catalog={catalog}
      payload={payload}
      inherited={inherited}
      saving={saving}
      serverFields={serverFields}
      submitLabel="Save overrides"
      onSubmit={onSubmit}
    />
  );
}
