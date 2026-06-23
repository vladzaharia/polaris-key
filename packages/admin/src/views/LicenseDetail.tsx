import React, { useState } from "react";
import { api, type ConfigEntry, type LicenseDetail as LicenseDetailDto, type OverrideUpdate, type ProductCatalog } from "../api.js";
import { invalidate, useAdmin, useResource, useStatus } from "../context.js";
import { navigate } from "../route.js";
import { SchemaField, type FieldResult } from "../SchemaForm.js";

/** A license detail: keys, machines, and a schema-driven override editor. */
export function LicenseDetailView({ id }: { id: string }): React.ReactElement {
  const { product } = useAdmin();
  const lic = useResource<LicenseDetailDto>(`license:${product}:${id}`, () => api.license(product, id));
  const cat = useResource<ProductCatalog>(`schema:${product}`, () => api.schema(product));
  const { announce } = useStatus();

  if (lic.error) return <p className="note note-error">{lic.error}</p>;
  if (!lic.data) return <p className="muted">Loading…</p>;
  const license = lic.data;

  async function toggle(): Promise<void> {
    try {
      await api.setLicenseEnabled(product, id, license.status !== "active");
      invalidate(`license:${product}:${id}`);
      invalidate(`licenses:${product}`);
      lic.reload();
      announce("Updated license status.", "ok");
    } catch (e) {
      announce(e instanceof Error ? e.message : "Failed.", "error");
    }
  }

  async function mint(): Promise<void> {
    try {
      const res = await api.mintKey(product, id);
      announce(`New key (shown once): ${res.key}`, "ok");
      invalidate(`license:${product}:${id}`);
      lic.reload();
    } catch (e) {
      announce(e instanceof Error ? e.message : "Failed.", "error");
    }
  }

  return (
    <section>
      <p className="crumbs">
        <a href="#" onClick={(e) => { e.preventDefault(); navigate({ kind: "product", slug: product, view: "licenses" }); }}>
          ← Licenses
        </a>
      </p>
      <h1 tabIndex={-1}>{license.name || license.id}</h1>
      <p className="muted">
        {license.email} · <span className={`pill pill-${license.status}`}>{license.status}</span>
      </p>
      <div className="row-actions">
        <button onClick={toggle}>{license.status === "active" ? "Disable" : "Enable"}</button>
        <button onClick={mint}>Mint key</button>
      </div>

      <h2>Keys</h2>
      <table className="data-table">
        <thead>
          <tr>
            <th>Hash</th>
            <th>Status</th>
            <th>Label</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {license.keys.map((k) => (
            <tr key={k.hash}>
              <td>
                <code>{k.hash.slice(0, 12)}…</code>
              </td>
              <td>{k.status}</td>
              <td>{k.label ?? "—"}</td>
              <td>
                {k.status === "active" ? (
                  <button
                    onClick={async () => {
                      await api.revokeKey(product, id, k.hash);
                      invalidate(`license:${product}:${id}`);
                      lic.reload();
                    }}
                  >
                    Revoke
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Devices</h2>
      <table className="data-table">
        <thead>
          <tr>
            <th>Machine</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {license.machines.map((m) => (
            <tr key={m.machineId}>
              <td>
                <code>{m.machineId}</code>
              </td>
              <td>{m.status}</td>
              <td>
                {m.status === "authorized" ? (
                  <button
                    onClick={async () => {
                      await api.deauthorizeMachine(product, id, m.machineId);
                      invalidate(`license:${product}:${id}`);
                      lic.reload();
                    }}
                  >
                    Deauthorize
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Overrides</h2>
      {cat.data ? (
        <OverrideEditor
          entries={cat.data.entries}
          current={license.overrides}
          onSave={async (updates) => {
            await api.setLicenseOverrides(product, id, updates);
            invalidate(`license:${product}:${id}`);
            lic.reload();
            announce("Overrides saved.", "ok");
          }}
        />
      ) : (
        <p className="muted">Loading catalog…</p>
      )}
    </section>
  );
}

/** A schema-driven batch editor over the three managed buckets. */
export function OverrideEditor({
  entries,
  current,
  onSave,
}: {
  entries: ConfigEntry[];
  current: LicenseDetailDto["overrides"];
  onSave: (updates: OverrideUpdate[]) => Promise<void>;
}): React.ReactElement {
  const initial: Record<string, unknown> = {};
  for (const e of entries) {
    const bucket = e.kind === "secret" ? current.secrets : e.kind === "flag" ? current.entitlements : current.config;
    const v = bucket[e.key] as { value?: unknown } | undefined;
    initial[e.key] = v && "value" in v ? v.value : undefined;
  }
  const [draft, setDraft] = useState<Record<string, FieldResult>>({});
  const [error, setError] = useState<string | null>(null);

  function setField(key: string, result: FieldResult): void {
    setDraft((d) => ({ ...d, [key]: result }));
  }

  async function save(ev: React.FormEvent): Promise<void> {
    ev.preventDefault();
    const updates: OverrideUpdate[] = [];
    for (const [key, result] of Object.entries(draft)) {
      if (!result.valid) {
        setError(`Invalid value for ${key}.`);
        return;
      }
      updates.push({ key, value: result.value, state: result.value === undefined ? "unmanaged" : "managed" });
    }
    setError(null);
    await onSave(updates);
    setDraft({});
  }

  return (
    <form onSubmit={save}>
      {error ? (
        <p className="note note-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="form-grid">
        {entries.map((e) => (
          <SchemaField
            key={e.key}
            entry={e}
            value={e.key in draft ? draft[e.key]!.value : initial[e.key]}
            onChange={(r) => setField(e.key, r)}
          />
        ))}
      </div>
      <button type="submit" disabled={Object.keys(draft).length === 0}>
        Save overrides
      </button>
    </form>
  );
}
