import React, { useState } from "react";
import { api, type ProductDetail } from "../api.js";
import { invalidate, useResource, useStatus } from "../context.js";
import { navigate } from "../route.js";

/** Platform-admin product registry: list + create (only platform admins reach this). */
export function Products(): React.ReactElement {
  const { data, error, reload } = useResource("products", () => api.products());
  const { announce } = useStatus();
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [created, setCreated] = useState<{ slug: string; signingKeySecret: string } | null>(null);

  async function create(ev: React.FormEvent): Promise<void> {
    ev.preventDefault();
    try {
      const res = await api.createProduct({ slug, name: name || slug });
      setCreated({ slug: res.product.slug, signingKeySecret: res.signingKeySecret });
      setSlug("");
      setName("");
      invalidate("products");
      reload();
      announce(`Created product ${res.product.slug}`, "ok");
    } catch (e) {
      announce(e instanceof Error ? e.message : "Create failed.", "error");
    }
  }

  return (
    <section>
      <h1 tabIndex={-1}>Products</h1>
      {error ? <p className="note note-error">{error}</p> : null}
      {created ? (
        <p className="note note-ok">
          Created <strong>{created.slug}</strong>. Set its signing key in the Worker secret{" "}
          <code>{created.signingKeySecret}</code> before clients can verify config.
        </p>
      ) : null}

      <table className="data-table">
        <thead>
          <tr>
            <th>Slug</th>
            <th>Name</th>
            <th>Admin group</th>
            <th>Machine limit</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(data?.products ?? []).map((prod: ProductDetail) => (
            <tr key={prod.slug}>
              <td>
                <code>{prod.slug}</code>
              </td>
              <td>{prod.name}</td>
              <td>{prod.adminGroup ?? "—"}</td>
              <td>{prod.defaultMachineLimit}</td>
              <td>
                <button onClick={() => navigate({ kind: "product", slug: prod.slug, view: "licenses" })}>Open</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <form className="inline-form" onSubmit={create}>
        <h2>New product</h2>
        <input aria-label="Product slug" placeholder="slug (a-z0-9-)" value={slug} onChange={(e) => setSlug(e.target.value)} required />
        <input aria-label="Product name" placeholder="Display name" value={name} onChange={(e) => setName(e.target.value)} />
        <button type="submit">Create product</button>
      </form>
    </section>
  );
}
