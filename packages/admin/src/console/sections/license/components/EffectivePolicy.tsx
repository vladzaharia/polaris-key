/** The "Effective policy" card: each limit and where it comes from. */

import * as React from "react";
import { type PolicyLine } from "./shared.js";

export function EffectivePolicy({
  lines,
  title = "Effective policy",
  description,
}: {
  lines: PolicyLine[];
  title?: string;
  description?: React.ReactNode;
}): React.ReactElement {
  return (
    <section
      aria-label={title}
      className="rounded-lg border border-border bg-surface-sunken p-4"
    >
      <h3 className="text-sm font-semibold text-fg-strong">{title}</h3>
      {description ? (
        <p className="mt-0.5 text-xs text-fg-muted">{description}</p>
      ) : null}
      <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        {lines.map((l) => (
          <div key={l.label} className="min-w-0">
            <dt className="text-xs text-fg-muted">{l.label}</dt>
            <dd className="text-fg-strong">
              {l.value}{" "}
              <span className="text-xs font-normal text-fg-muted">
                ({l.from})
              </span>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
