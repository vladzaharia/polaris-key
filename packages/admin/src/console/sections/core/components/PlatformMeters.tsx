/**
 * Per-platform progress (ST-41): one meter per platform an SDK was seen or Verified on, as many
 * segments as there are features and one filled for each Verified there. The count is the word;
 * the bar repeats it (never colour alone, never an invented percentage).
 */

import * as React from "react";
import type { IntegrationView } from "../../../../api.js";
import { platformProgress } from "../model/integration.js";

export function PlatformMeters({
  view,
  label = "By platform",
}: {
  view: IntegrationView;
  label?: string;
}): React.ReactElement | null {
  const rows = platformProgress(view);
  if (rows.length === 0) return null;
  return (
    <ul aria-label={label} className="space-y-2.5">
      {rows.map((p) => (
        <li key={p.platform} className="space-y-1">
          <p className="flex flex-wrap items-baseline justify-between gap-x-2 text-sm">
            <span className="font-medium text-fg-strong">{p.label}</span>
            <span className="ml-auto whitespace-nowrap text-right text-fg-muted">
              {p.verified} of {p.total} verified
            </span>
          </p>
          <div aria-hidden className="flex gap-0.5">
            {Array.from({ length: p.total }, (_, i) => (
              <span
                key={i}
                className={
                  i < p.verified
                    ? "h-1 flex-1 rounded-full bg-success"
                    : "h-1 flex-1 rounded-full bg-surface-sunken"
                }
              />
            ))}
          </div>
        </li>
      ))}
    </ul>
  );
}
