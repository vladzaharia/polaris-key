/**
 * A channel's Setup tab (A-22.3). Sections are independent; each owns its reads.
 *
 * - Store controls (A-22.3b): the store connector card for this channel, moved off Outlet
 *   credentials. Its configuration actions stay here; the rollout verbs stay in the Matrix cell
 *   drawer. A channel with no store connector draws nothing.
 */

import * as React from "react";
import { Section } from "../../../../ui/Section.js";
import { useConnectors } from "../data.js";
import { useReleaseStore } from "../../release/data.js";
import { ConnectorGrid, connectorsFor } from "./ConnectorGrid.js";
import type { ChannelTabProps } from "./channelTabs.js";

export function ChannelSetup(props: ChannelTabProps): React.ReactElement {
  return (
    <div className="space-y-6">
      <ChannelStoreControls {...props} />
    </div>
  );
}

// --- Store controls (A-22.3b) ---------------------------------------------------------------

export function ChannelStoreControls({
  slug,
  channel,
}: ChannelTabProps): React.ReactElement | null {
  const connectors = useConnectors(slug);
  const store = useReleaseStore(slug);
  if (!connectors.data) return null;
  if (connectorsFor(connectors.data.connectors, channel.id).length === 0)
    return null;
  return (
    <Section title="Store controls">
      <ConnectorGrid
        slug={slug}
        connectors={connectors.data.connectors}
        releases={store.data}
        channelId={channel.id}
      />
    </Section>
  );
}
