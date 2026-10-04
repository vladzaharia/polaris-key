/**
 * T2 · Collection (ADMIN.md §3): Products, Devices, Licenses, Releases, Rollouts, Platform
 * deploy history and cron runs, Package feeds (S-12)…
 *
 *   PageHeader: title (count) · description · [Primary: New …] [⋯]
 *   Optional summary strip: 2–4 StatTiles or facet tiles
 *   DataTable (its FilterBar, bulk bar, pager and states are the table's own)
 *
 * Create flows open a `Drawer` (small objects) or a `Dialog` that becomes a `OneTimeSecretPanel`
 * (one-time results); large objects use a T6 wizard page.
 */

import * as React from "react";

export function CollectionTemplate({
  header,
  summary,
  children,
}: {
  header: React.ReactNode;
  /** 2–4 `StatTile`s or facet tiles (buttons with `aria-pressed`). */
  summary?: React.ReactNode;
  /** The `DataTable` (and any drawer it opens). */
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="space-y-6" data-template="collection">
      {header}
      {summary ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{summary}</div>
      ) : null}
      {children}
    </div>
  );
}
