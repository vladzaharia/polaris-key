/**
 * An outlet drawer's subtitle: its kind, and (A-22.4, until A-22.7's entry points land) a link to
 * the channel page that outlet serves, when it serves one.
 */

import * as React from "react";
import { channelForOutlet } from "@polaris-key/manifest";
import type { OutletDto } from "../../../../api.js";
import { Link } from "../../../router.js";
import { r } from "../../../routes.js";
import { outletKindLabel } from "../model/format.js";

export function OutletKindLine({
  slug,
  outlet,
}: {
  slug: string;
  outlet: OutletDto;
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
