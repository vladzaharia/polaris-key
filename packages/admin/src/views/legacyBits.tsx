import * as React from "react";
import { Badge } from "../components/ui/index.js";

/**
 * The three helpers the legacy Devices and Profile detail views still import from the License
 * views chunk 6 rebuilt. They go when those views are rebuilt (chunks 5 and 7) or in chunk 11.
 */

/** Format an epoch-seconds timestamp as a locale date-time, or an em-dash when absent. */
export function formatStamp(epochSeconds?: number | null): string {
  if (!epochSeconds) return "—";
  try {
    return new Date(epochSeconds * 1000).toLocaleString();
  } catch {
    return "—";
  }
}

export function DeviceStatusBadge({
  status,
}: {
  status: string;
}): React.ReactElement {
  const variant =
    status === "active" || status === "authorized" ? "success" : "default";
  return <Badge variant={variant}>{status}</Badge>;
}

/** A labelled key/value pair for the detail header metadata grid. */
export function MetaItem({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd className="text-sm text-foreground">{children}</dd>
    </div>
  );
}
