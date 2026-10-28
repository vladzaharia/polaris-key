/**
 * A channel's Releases tab (A-22.2): that store's rollouts, with the same row actions and dialogs
 * as Distribution → Rollouts (`RolloutList`). The read model serves no per-channel lane or
 * live-version fact, so only the rollouts of the channel's own outlets are drawn.
 */

import * as React from "react";
import { channelForOutlet } from "@polaris-key/manifest";
import type { Rollout } from "../../../../api.js";
import type { OutletDto } from "../../../../api.js";
import { Button } from "../../../../ui/Button.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { useWriteGate } from "../../../access/useCan.js";
import { r } from "../../../routes.js";
import { useOutlets, useRollouts } from "../data.js";
import { cellKey } from "../pages/MatrixPage.js";
import { RolloutList } from "./RolloutList.js";
import type { ChannelTabProps } from "./channelTabs.js";

/** The package-manager subkind of a `direct` outlet, as the Worker reads it. */
function subkindOf(o: OutletDto): string | null {
  if (o.kind !== "direct") return null;
  const id = o.identity;
  if (typeof id.subkind === "string") return id.subkind;
  return typeof id.homebrewCask === "string" ||
    typeof id.homebrewFormula === "string"
    ? "homebrew"
    : null;
}

/** The ids of the live outlets that serve this channel. */
export function outletIdsOf(
  outlets: readonly OutletDto[],
  channelId: string,
): Set<string> {
  return new Set(
    outlets
      .filter(
        (o) =>
          o.removedAt === null &&
          channelForOutlet(o.kind, subkindOf(o))?.id === channelId,
      )
      .map((o) => o.outletId),
  );
}

export function ChannelReleases({
  slug,
  channel,
}: ChannelTabProps): React.ReactElement {
  const gate = useWriteGate("ship", slug);
  const rollouts = useRollouts(slug);
  const outlets = useOutlets(slug);
  const [starting, setStarting] = React.useState(false);
  const ids = React.useMemo(
    () => outletIdsOf(outlets.data?.outlets ?? [], channel.id),
    [outlets.data, channel.id],
  );
  const keep = React.useCallback((x: Rollout) => ids.has(x.outletId), [ids]);
  const first = [...ids].sort()[0];
  const hrefFor = (x: Rollout): string => {
    const q = new URLSearchParams({ cell: cellKey(x.releaseId, x.outletId) });
    if (x.deliverableId !== "app") q.set("deliverable", x.deliverableId);
    return `${r.rollouts(slug)}?${q.toString()}`;
  };

  if (outlets.isError && !outlets.data)
    return (
      <ErrorState
        error={outlets.error}
        onRetry={() => void outlets.refetch()}
        thing="Channels"
      />
    );
  return (
    <section aria-labelledby="channel-rollouts-heading" className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2
          id="channel-rollouts-heading"
          className="text-base font-semibold text-fg-strong"
        >
          Rollouts
        </h2>
        <Button
          variant="outline"
          disabledReason={gate.disabledReason}
          onClick={() => setStarting(true)}
        >
          Start rollout…
        </Button>
      </div>
      <RolloutList
        slug={slug}
        rollouts={rollouts}
        keep={keep}
        loading={outlets.isPending}
        tableId="channel-rollouts"
        hrefFor={hrefFor}
        starting={starting}
        onStartingChange={setStarting}
        startInitial={{ deliverable: "app", outlet: first }}
        emptyDescription={`No rollout on ${channel.label} yet. Without one, it offers its release to everyone.`}
      />
    </section>
  );
}
