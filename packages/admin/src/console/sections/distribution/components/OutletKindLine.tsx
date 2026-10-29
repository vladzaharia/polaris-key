/**
 * An outlet drawer's subtitle: its kind, the release track when given, and a link to the channel
 * page that outlet serves, when it serves one (A-22.7).
 */

import * as React from "react";
import type { RowActionItem } from "../../../../ui/data-table/types.js";
import { Link, navigate } from "../../../router.js";
import { r } from "../../../routes.js";
import { patchQuery } from "../data.js";
import { outletKindLabel } from "../model/format.js";
import { channelOfOutlet, type OutletLike } from "../model/subkind.js";

export function OutletKindLine({
  slug,
  outlet,
  track,
}: {
  slug: string;
  outlet: OutletLike;
  /** The release track, shown before the channel link so it never reads as the channel's. */
  track?: string;
}): React.ReactElement {
  const channel = channelOfOutlet(outlet);
  return (
    <>
      {outletKindLabel(outlet.kind)}
      {track ? ` · ${track}` : null}
      {channel ? (
        <>
          {" · "}
          <Link
            to={r.channel(slug, channel.id)}
            className="inline-flex min-h-6 items-center text-accent-fg underline underline-offset-4"
          >
            Open {channel.label} channel
          </Link>
        </>
      ) : null}
    </>
  );
}

/** An Outlets row's menu: open the drawer, and the channel page when the outlet serves one. */
export function outletRowActions(
  slug: string,
  outlet: { outletId: string; kind: string; identity: Record<string, unknown> },
): RowActionItem[] {
  const channel = channelOfOutlet(outlet);
  return [
    {
      label: "Open details",
      onSelect: () => patchQuery({ outlet: outlet.outletId }, { push: true }),
    },
    ...(channel
      ? [
          {
            label: `Open ${channel.label} channel`,
            onSelect: () => navigate(r.channel(slug, channel.id)),
          },
        ]
      : []),
  ];
}
