import React, { useState } from "react";
import { api, type LicenseSummary } from "../api.js";
import { invalidate, useAdmin, useResource, useStatus } from "../context.js";
import { navigate } from "../route.js";

/** Per-product license roster + create (mints a key, shown once). */
export function Licenses(): React.ReactElement {
  const { product } = useAdmin();
  const { data, error, reload } = useResource(`licenses:${product}`, () => api.licenses(product));
  const { announce } = useStatus();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [mintedKey, setMintedKey] = useState<string | null>(null);

  async function create(ev: React.FormEvent): Promise<void> {
    ev.preventDefault();
    try {
      const res = await api.createLicense(product, { name, email });
      setMintedKey(res.key);
      setName("");
      setEmail("");
      invalidate(`licenses:${product}`);
      reload();
      announce("License created.", "ok");
    } catch (e) {
      announce(e instanceof Error ? e.message : "Create failed.", "error");
    }
  }

  return (
    <section>
      <h1 tabIndex={-1}>Licenses</h1>
      {error ? <p className="note note-error">{error}</p> : null}
      {mintedKey ? (
        <p className="note note-ok">
          New license key (copy it now — it is shown only once): <code>{mintedKey}</code>
        </p>
      ) : null}

      <table className="data-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Status</th>
            <th>Keys</th>
            <th>Devices</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(data?.licenses ?? []).map((lic: LicenseSummary) => (
            <tr key={lic.id}>
              <td>{lic.name || "—"}</td>
              <td>{lic.email || "—"}</td>
              <td>
                <span className={`pill pill-${lic.status}`}>{lic.status}</span>
              </td>
              <td>
                {lic.activeKeyCount}/{lic.keyCount}
              </td>
              <td>{lic.machineCount}</td>
              <td>
                <button onClick={() => navigate({ kind: "product", slug: product, view: "license", id: lic.id })}>Open</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <form className="inline-form" onSubmit={create}>
        <h2>New license</h2>
        <input aria-label="License name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <input aria-label="License email" placeholder="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <button type="submit">Create license</button>
      </form>
    </section>
  );
}
