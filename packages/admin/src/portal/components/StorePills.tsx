import * as React from "react";
import { ExternalLink } from "lucide-react";
import type { PortalStoreLink } from "../api.js";
import { GET_IT_COPY as C } from "../copy/getIt.js";

/** The outlined pill every store and install-source link in the portal uses (P0-48: one look). */
export const PILL_CLASS =
  "inline-flex h-11 items-center gap-2 rounded-full border border-border-strong px-4 text-sm font-medium text-fg-strong hover:bg-hover";

/** The live stores with a page, as {@link StorePillList} shows them. */
export function liveStores(
  stores: readonly PortalStoreLink[],
): PortalStoreLink[] {
  return stores.filter((s) => s.live && s.url);
}

/**
 * The pills alone: one per live store, opening the store's page in a new tab. Store labels are
 * fixed Worker strings and every URL is built by the Worker from a validated store identity
 * (PX-W2). Renders nothing without a live store.
 */
export function StorePillList({
  stores,
  labelledBy,
}: {
  stores: readonly PortalStoreLink[];
  /** The id of the heading or label that names the list. */
  labelledBy?: string;
}): React.ReactElement | null {
  const live = liveStores(stores);
  if (live.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-2" aria-labelledby={labelledBy}>
      {live.map((s) => (
        <li key={s.id}>
          <a
            href={s.url!}
            target="_blank"
            rel="noreferrer"
            className={PILL_CLASS}
          >
            {s.label}
            <ExternalLink aria-hidden className="size-4 text-accent-fg" />
            <span className="sr-only">{C["getIt.newTab"]}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

/**
 * "Also yours on" (§4.13, §4.20): the label, then {@link StorePillList}. Renders nothing without a
 * live store.
 */
export function StorePills({
  stores,
  label = C["getIt.alsoYoursOn"],
}: {
  stores: readonly PortalStoreLink[];
  label?: string;
}): React.ReactElement | null {
  const id = React.useId();
  if (liveStores(stores).length === 0) return null;
  return (
    <div className="space-y-2">
      <p id={id} className="text-sm text-fg-muted">
        {label}
      </p>
      <StorePillList stores={stores} labelledBy={id} />
    </div>
  );
}
