import React from "react";
import { api, type ActivityItem } from "../api.js";
import { useAdmin, useResource } from "../context.js";

/** Per-product audit feed (keyset-paginated; first page only for this small console). */
export function Activity(): React.ReactElement {
  const { product } = useAdmin();
  const { data, error } = useResource(`activity:${product}`, () => api.activity(product));

  return (
    <section>
      <h1 tabIndex={-1}>Activity</h1>
      {error ? <p className="note note-error">{error}</p> : null}
      <table className="data-table">
        <thead>
          <tr>
            <th>When</th>
            <th>Actor</th>
            <th>Action</th>
            <th>Summary</th>
          </tr>
        </thead>
        <tbody>
          {(data?.items ?? []).map((item: ActivityItem) => (
            <tr key={item.id}>
              <td>{new Date(item.at * 1000).toLocaleString()}</td>
              <td>{item.actor.name || item.actor.sub}</td>
              <td>
                <code>{item.action}</code>
              </td>
              <td>{item.summary}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data && data.items.length === 0 ? <p className="muted">No activity yet.</p> : null}
    </section>
  );
}
