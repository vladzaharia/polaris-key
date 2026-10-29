/**
 * A channel's Setup tab (A-22.3): what Polaris Key needs to act on the store. Two sections, each
 * its own component so the next slice adds one without touching the other:
 *
 * - Credentials (A-22.3a): the store keys this channel signs in with, moved from the Credentials
 *   page. Values are write-only: sent once, never read back, never rendered, never in a URL.
 * - Store controls (A-22.3b): the connector and its release controls. Not built yet.
 */

import * as React from "react";
import { Plus } from "lucide-react";
import { Button } from "../../../../ui/Button.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { Section } from "../../../../ui/Section.js";
import { docsUrl } from "../../../../lib/docsLinks.js";
import { useCredentials } from "../data.js";
import { kindsOfChannel } from "../model/channelScope.js";
import { KIND } from "../model/credentialKinds.js";
import { CredentialTable, useCredentialEditor } from "./CredentialEditors.js";
import type { ChannelTabProps } from "./channelTabs.js";

/** Does this channel have store keys to set? Only then does its Setup tab show. */
export const hasCredentials = (channelId: string): boolean =>
  kindsOfChannel(channelId).length > 0;

export function ChannelSetup(props: ChannelTabProps): React.ReactElement {
  return (
    <div className="space-y-8">
      <ChannelCredentials {...props} />
      {/* A-22.3b: the store controls section goes here, as its own component. */}
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
  const editor = useCredentialEditor({
    slug,
    creds,
    rows,
    kinds,
    channelScoped: true,
  });
  return (
    <Section
      title="Credentials"
      description={`The keys Polaris Key signs in to ${channel.label} with. Values are sent once and never shown again.`}
      actions={
        // One action, once: the empty state carries its own.
        rows.length ? (
          <Button iconStart={<Plus aria-hidden />} onClick={editor.create}>
            Set credential…
          </Button>
        ) : undefined
      }
    >
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
              <Button onClick={editor.create}>Set credential…</Button>
            }
            docs={docsUrl("credentialsPage")}
          />
        }
      />
      {editor.dialogs}
    </Section>
  );
}
