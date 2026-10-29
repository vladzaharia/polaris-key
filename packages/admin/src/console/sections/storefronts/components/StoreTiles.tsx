import * as React from "react";
import type { StorefrontDto } from "../../../../api.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { Button } from "../../../../ui/Button.js";
import {
  CapabilityStrip,
  capabilitySummary,
} from "../../../../ui/CapabilityBadge.js";
import { useWriteGate } from "../../../access/useCan.js";
import { Link } from "../../../router.js";
import { r } from "../../../routes.js";
import { ConnectionIssue, progress } from "./FlowPanels.js";

/** The Storefronts page's tiles (A-18j): one per registered store, rendered from its declaration. */

export function StoreTile({
  slug,
  store,
  hasPanel,
  outOfScope = false,
}: {
  slug: string;
  store: StorefrontDto;
  /** The store has a page of its own (`STORE_PANELS`). */
  hasPanel: boolean;
  /** Declared by the team, but no platform or build of the product fits it (A-20.7). */
  outOfScope?: boolean;
}): React.ReactElement {
  const gate = useWriteGate("ship", slug);
  if (store.builtIn)
    return <BuiltInTile slug={slug} store={store} hasPanel={hasPanel} />;
  const p = progress(store);
  return (
    <section
      aria-label={store.label}
      data-store={store.id}
      className="flex min-w-0 flex-col rounded-lg border border-border bg-surface-raised"
    >
      <div className="flex min-h-14 items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-fg-strong">
            {store.label}
          </h2>
          <p className="break-words text-sm text-fg-muted">
            {store.app
              ? (store.app.name ?? store.app.id)
              : store.connection.state === "keyless"
                ? "Published from CI"
                : "No app assigned"}
          </p>
        </div>
        {outOfScope ? (
          <StatusPill tone="warning" size="sm">
            Out of scope
          </StatusPill>
        ) : (
          <ConnectionIssue store={store} />
        )}
      </div>
      <div className="flex-1 px-4 py-2">
        <CapabilityStrip
          label={`${store.label}: what it allows`}
          items={store.capabilities.filter(
            (c) =>
              c.op !== "connect" && c.op !== "listApps" && c.op !== "status",
          )}
        />
      </div>
      <div className="flex min-h-14 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-border px-4 py-2">
        <span className="text-sm text-fg-muted">
          {p.total
            ? `${p.done} of ${p.total} steps done`
            : capabilitySummary(store.capabilities)}
        </span>
        <Button
          size="sm"
          variant="outline"
          asChild
          disabledReason={gate.disabledReason}
        >
          <Link
            to={r.storefronts(slug, {
              flow: "add",
              stores: store.id,
              step: "prerequisites",
            })}
          >
            Set up
          </Link>
        </Button>
      </div>
    </section>
  );
}

/**
 * A built-in store's tile: always connected (there is no credential), its capabilities from the
 * declaration ("Built in"), and **Manage**, which opens the store's own page.
 */
function BuiltInTile({
  slug,
  store,
  hasPanel,
}: {
  slug: string;
  store: StorefrontDto;
  hasPanel: boolean;
}): React.ReactElement {
  return (
    <section
      aria-label={store.label}
      data-store={store.id}
      data-built-in=""
      className="flex min-w-0 flex-col rounded-lg border border-border bg-surface-raised"
    >
      <div className="flex min-h-14 items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-fg-strong">
            {store.label}
          </h2>
          <p className="break-words text-sm text-fg-muted">
            Built in: always connected
          </p>
        </div>
      </div>
      <div className="flex-1 px-4 py-2">
        <CapabilityStrip
          label={`${store.label}: what it allows`}
          items={store.capabilities.filter(
            (c) =>
              c.op !== "connect" && c.op !== "listApps" && c.op !== "status",
          )}
        />
      </div>
      <div className="flex min-h-14 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-border px-4 py-2">
        <span className="text-sm text-fg-muted">
          {capabilitySummary(store.capabilities)}
        </span>
        {hasPanel ? (
          <Button size="sm" variant="outline" asChild>
            <Link to={r.channel(slug, store.id, "sales")}>Manage</Link>
          </Button>
        ) : null}
      </div>
    </section>
  );
}
