/**
 * An outlet drawer's subtitle: its kind, and (A-22.7) a link to
 * the channel page that outlet serves, when it serves one.
 */

import * as React from "react";
import { channelForOutlet } from "@polaris-key/manifest";
import type { RowActionItem } from "../../../../ui/data-table/types.js";
import { Link, navigate } from "../../../router.js";
import { r } from "../../../routes.js";
import { patchQuery } from "../data.js";
import { outletKindLabel } from "../model/format.js";

export function OutletKindLine({
  slug,
  outlet,
}: {
  slug: string;
  outlet: { kind: string };
}): React.ReactElement {
  const channel = channelForOutlet(outlet.kind);
  return (
    <>
      {outletKindLabel(outlet.kind)}
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
  outlet: { outletId: string; kind: string },
): RowActionItem[] {
  const channel = channelForOutlet(outlet.kind);
  return [
    {
      label: "Open",
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
