import * as React from "react";
import { ExternalLink } from "lucide-react";
import type { PortalStoreLink } from "../api.js";

/**
 * "Also yours on" (§4.13, §4.20): one outlined pill per store reporting a live release, opening
 * the store's page in a new tab. Store labels are fixed Worker strings and every URL is built by
 * the Worker from a validated store identity (PX-W2). Renders nothing without a live store.
 */
export function StorePills({
  stores,
  label = "Also yours on",
}: {
  stores: readonly PortalStoreLink[];
  label?: string;
}): React.ReactElement | null {
  const live = stores.filter((s) => s.live && s.url);
  if (live.length === 0) return null;
  return (
    <div className="space-y-2">
      <p className="text-sm text-fg-muted">{label}</p>
      <ul className="flex flex-wrap gap-2">
        {live.map((s) => (
          <li key={s.id}>
            <a
              href={s.url!}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-11 items-center gap-2 rounded-full border border-border-strong px-4 text-sm font-bold text-fg-strong hover:bg-hover"
            >
              {s.label}
              <ExternalLink aria-hidden className="size-4 text-accent-fg" />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
