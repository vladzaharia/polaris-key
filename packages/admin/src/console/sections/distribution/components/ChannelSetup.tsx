/**
 * A channel's Setup tab (A-22.3): what Polaris Key needs to act on the store. Two sections, each
 * its own component so the next slice adds one without touching the other:
 *
 * - Credentials (A-22.3a): the store keys this channel signs in with, moved from the Credentials
 *   page. Values are write-only: sent once, never read back, never rendered, never in a URL.
 * - Store controls (A-22.3b): the store connector card for this channel, moved off Outlet
 *   credentials. Its configuration actions stay here; the rollout verbs stay in the Matrix cell
 *   drawer. A channel with no store connector draws nothing.
 */

import * as React from "react";
import { Plus } from "lucide-react";
import { Button } from "../../../../ui/Button.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { Section } from "../../../../ui/Section.js";
import { docsUrl } from "../../../../lib/docsLinks.js";
import { useConnectors, useCredentials } from "../data.js";
import { useReleaseStore } from "../../release/data.js";
import { channelLabel } from "@polaris-key/manifest";
import { useWriteGate } from "../../../access/useCan.js";
import { channelInScope } from "../../../nav.js";
import {
  channelsOfKind,
  kindsOfChannel,
  useScope,
} from "../model/channelScope.js";
import { KIND } from "../model/credentialKinds.js";
import { ConnectorGrid, connectorsFor } from "./ConnectorGrid.js";
import { CredentialTable, useCredentialEditor } from "./CredentialEditors.js";
import type { ChannelTabProps } from "./channelTabs.js";

/** Does this channel have store keys to set? Only then does its Setup tab show. */
export const hasCredentials = (channelId: string): boolean =>
  kindsOfChannel(channelId).length > 0;

export function ChannelSetup(props: ChannelTabProps): React.ReactElement {
  return (
    <div className="space-y-8">
      <ChannelCredentials {...props} />
      <ChannelStoreControls {...props} />
    </div>
  );
}

function ChannelCredentials({
  slug,
  channel,
}: ChannelTabProps): React.ReactElement {
  const creds = useCredentials(slug);
  const kindIds = kindsOfChannel(channel.id);
  const kinds = kindIds.flatMap((k) => KIND.get(k) ?? []);
  const rows = (creds.data?.credentials ?? []).filter((c) =>
    kindIds.includes(c.kind),
  );
  const gate = useWriteGate("ship", slug);
  const features = useScope(slug);
  // A key can serve two channels (Google Play and its testing track): a change here changes both.
  const alsoUsedBy = (kind: string): string[] =>
    channelsOfKind(kind)
      .filter((id) => id !== channel.id && channelInScope(features, id))
      .map((id) => channelLabel(id));
  const shared = [...new Set(kindIds.flatMap(alsoUsedBy))];
  const editor = useCredentialEditor({
    slug,
    creds,
    rows,
    kinds,
    channelScoped: true,
    channelName: channel.label,
    disabledReason: gate.disabledReason,
    alsoUsedBy,
  });
  return (
    <Section
      title="Credentials"
      description={`The keys Polaris Key signs in to ${channel.label} with.${
        shared.length ? ` Also used by ${shared.join(" and ")}.` : ""
      } Values are sent once and never shown again.`}
    >
      {rows.length ? (
        // One action, once (the empty state carries its own). In the body, not the head band, so
        // it never squeezes the description on a phone.
        <div className="mb-3 flex justify-end">
          <Button
            iconStart={<Plus aria-hidden />}
            disabledReason={gate.disabledReason}
            onClick={editor.create}
          >
            Set credential…
          </Button>
        </div>
      ) : null}
      <CredentialTable
        editor={editor}
        creds={creds}
        rows={rows}
        id={`channel-credentials-${channel.id}`}
        caption={`${channel.label} credentials`}
        channelColumn={false}
        filters={false}
        empty={
          <EmptyState
            kind="first-run"
            title={`No ${channel.label} credentials yet`}
            description={`A connector needs ${channel.label}'s key to read review and release state and to drive staged rollouts.`}
            primaryAction={
              <Button
                disabledReason={gate.disabledReason}
                onClick={editor.create}
              >
                Set credential…
              </Button>
            }
            docs={docsUrl("credentialsPage")}
          />
        }
      />
      {editor.dialogs}
    </Section>
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
