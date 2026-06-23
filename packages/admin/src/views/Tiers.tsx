import React, { useState } from "react";
import { api, type TierSummary } from "../api.js";
import { invalidate, useAdmin, useResource, useStatus } from "../context.js";

/** Per-product tiers (named plan = profile bundle + policy). */
export function Tiers(): React.ReactElement {
  const { product } = useAdmin();
  const { data, error, reload } = useResource(`tiers:${product}`, () => api.tiers(product));
  const { announce } = useStatus();
  const [id, setId] = useState("");
  const [label, setLabel] = useState("");

  async function create(ev: React.FormEvent): Promise<void> {
    ev.preventDefault();
    try {
      await api.createTier(product, { id: id || undefined, label: label || id });
      setId("");
      setLabel("");
      invalidate(`tiers:${product}`);
      reload();
      announce("Tier created.", "ok");
    } catch (e) {
      announce(e instanceof Error ? e.message : "Create failed.", "error");
    }
  }

  return (
    <section>
      <h1 tabIndex={-1}>Tiers</h1>
      {error ? <p className="note note-error">{error}</p> : null}
      <table className="data-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Label</th>
            <th>Profile</th>
            <th>Expiry (days)</th>
            <th>Machine limit</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(data?.tiers ?? []).map((t: TierSummary) => (
            <tr key={t.id}>
              <td>
                <code>{t.id}</code>
              </td>
              <td>{t.label}</td>
              <td>{t.profile ?? "—"}</td>
              <td>{t.policyExpiryDays ?? "—"}</td>
              <td>{t.policyMachineLimit ?? "—"}</td>
              <td>
                <button
                  onClick={async () => {
                    await api.deleteTier(product, t.id);
                    invalidate(`tiers:${product}`);
                    reload();
                  }}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form className="inline-form" onSubmit={create}>
        <h2>New tier</h2>
        <input aria-label="Tier id" placeholder="id" value={id} onChange={(e) => setId(e.target.value)} />
        <input aria-label="Tier label" placeholder="Label" value={label} onChange={(e) => setLabel(e.target.value)} />
        <button type="submit">Create tier</button>
      </form>
    </section>
  );
}
