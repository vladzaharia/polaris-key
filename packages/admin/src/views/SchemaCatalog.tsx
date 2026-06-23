import React, { useState } from "react";
import { api, type ConfigEntry, type ConfigKind, type ProductCatalog } from "../api.js";
import { invalidate, useAdmin, useResource, useStatus } from "../context.js";
import { SchemaField, type FieldResult } from "../SchemaForm.js";

/**
 * The config catalog authoring view. Lists the active entries, lets an admin add a new
 * `config`/`secret`/`flag` entry with a raw JSON-Schema fragment, and shows a LIVE PREVIEW
 * of how that entry renders (driven by the same SchemaField the override editor uses), so
 * authors can see the resulting widget + validation before publishing a new catalog version.
 */
export function SchemaCatalog(): React.ReactElement {
  const { product } = useAdmin();
  const { data, error, reload } = useResource<ProductCatalog>(`schema:${product}`, () => api.schema(product));
  const { announce } = useStatus();

  const [key, setKey] = useState("");
  const [kind, setKind] = useState<ConfigKind>("config");
  const [label, setLabel] = useState("");
  const [category, setCategory] = useState("general");
  const [description, setDescription] = useState("");
  const [schemaText, setSchemaText] = useState('{\n  "type": "string"\n}');
  const [previewValue, setPreviewValue] = useState<FieldResult>({ value: "", valid: true });
  const [formError, setFormError] = useState<string | null>(null);

  let parsedSchema: Record<string, unknown> | null = null;
  let schemaError: string | null = null;
  try {
    parsedSchema = JSON.parse(schemaText) as Record<string, unknown>;
  } catch (e) {
    schemaError = e instanceof Error ? e.message : "invalid JSON";
  }

  const draftEntry: ConfigEntry | null =
    parsedSchema && key
      ? { key, kind, category, label: label || key, description, schema: parsedSchema }
      : null;

  async function publish(ev: React.FormEvent): Promise<void> {
    ev.preventDefault();
    if (!data) return;
    if (!draftEntry) {
      setFormError("Provide a key and a valid JSON-Schema fragment.");
      return;
    }
    if (data.entries.some((e) => e.key === draftEntry.key)) {
      setFormError(`Key ${draftEntry.key} already exists.`);
      return;
    }
    const next: ProductCatalog = {
      schemaVersion: data.schemaVersion + 1,
      entries: [...data.entries, draftEntry],
    };
    try {
      await api.publishSchema(product, next);
      setFormError(null);
      setKey("");
      setLabel("");
      setDescription("");
      invalidate(`schema:${product}`);
      reload();
      announce("Published new catalog version.", "ok");
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Publish failed.");
    }
  }

  return (
    <section>
      <h1 tabIndex={-1}>Schema catalog</h1>
      {error ? <p className="note note-error">{error}</p> : null}
      <p className="muted">Active version: {data?.schemaVersion ?? "—"}</p>

      <table className="data-table">
        <thead>
          <tr>
            <th>Key</th>
            <th>Kind</th>
            <th>Category</th>
            <th>Label</th>
          </tr>
        </thead>
        <tbody>
          {(data?.entries ?? []).map((e) => (
            <tr key={e.key}>
              <td>
                <code>{e.key}</code>
              </td>
              <td>{e.kind}</td>
              <td>{e.category}</td>
              <td>{e.label}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <form className="authoring" onSubmit={publish}>
        <h2>Add an entry</h2>
        {formError ? (
          <p className="note note-error" role="alert">
            {formError}
          </p>
        ) : null}
        <div className="form-grid">
          <label>
            Key
            <input aria-label="Entry key" placeholder="run.concurrency" value={key} onChange={(e) => setKey(e.target.value)} required />
          </label>
          <label>
            Kind
            <select aria-label="Entry kind" value={kind} onChange={(e) => setKind(e.target.value as ConfigKind)}>
              <option value="config">config</option>
              <option value="secret">secret</option>
              <option value="flag">flag</option>
            </select>
          </label>
          <label>
            Category
            <input aria-label="Entry category" value={category} onChange={(e) => setCategory(e.target.value)} />
          </label>
          <label>
            Label
            <input aria-label="Entry label" value={label} onChange={(e) => setLabel(e.target.value)} />
          </label>
        </div>
        <label className="block">
          Description
          <input aria-label="Entry description" value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label className="block">
          JSON-Schema fragment
          <textarea aria-label="JSON Schema fragment" rows={6} value={schemaText} onChange={(e) => setSchemaText(e.target.value)} />
        </label>
        {schemaError ? (
          <p className="note note-error" role="alert">
            Schema JSON: {schemaError}
          </p>
        ) : null}

        {draftEntry ? (
          <div className="preview">
            <h3>Live preview</h3>
            <SchemaField entry={draftEntry} value={previewValue.value} onChange={setPreviewValue} />
          </div>
        ) : null}

        <button type="submit" disabled={!draftEntry}>
          Publish new version
        </button>
      </form>
    </section>
  );
}
