/**
 * Distribution → Credentials (ADMIN.md §6.4): the credentials that belong to no channel
 * (Sentry's integration secret, whose alerts open halt candidates), and a held credential whose
 * channel is out of scope for the product, flagged (A-20 R6). A store's own keys moved to its
 * channel's Setup tab (A-22.3a); this page links to each. Values are write-only: the table shows
 * metadata and health, never a value. The editors live in `CredentialEditors`. Store controls moved to each channel's Setup
 * (A-22.3b).
 *
 * - **Set credential** is a drawer: kind first, then its fields (OUT-3, OUT-4, OUT-5).
 */

import * as React from "react";
import { Plus } from "lucide-react";
import { channelLabel } from "@polaris-key/manifest";
import { docsUrl } from "../../../../lib/docsLinks.js";
import { Button } from "../../../../ui/Button.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { PageHeader } from "../../../../ui/PageHeader.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { useWriteGate } from "../../../access/useCan.js";
import { useProduct } from "../../../data/hooks.js";
import { channelInScope } from "../../../nav.js";
import { Link, navigate, useSearchParam } from "../../../router.js";
import { codecs, r } from "../../../routes.js";
import { CollectionTemplate } from "../../../templates/Collection.js";
import {
  CredentialTable,
  useCredentialEditor,
} from "../components/CredentialEditors.js";
import { useCredentials } from "../data.js";
import { KINDS } from "../model/credentialKinds.js";
import {
  CREDENTIAL_CHANNELS,
  channelsOfKind,
  kindInScope,
  useScope,
  useScopeLoading,
} from "../model/channelScope.js";

export { KINDS };

const CREDENTIAL = codecs.string("");

export function CredentialsPage({
  slug,
}: {
  slug: string;
}): React.ReactElement {
  const creds = useCredentials(slug);
  const features = useScope(slug);
  const scopeLoading = useScopeLoading(slug);
  const [openId] = useSearchParam("credential", CREDENTIAL);
  const gate = useWriteGate("ship", slug);
  const name = useProduct(slug).data?.name ?? slug;

  const all = creds.data?.credentials ?? [];
  const outOfScope = (kind: string): boolean =>
    channelsOfKind(kind).length > 0 && !kindInScope(features, kind);
  // This page holds what no channel page can: kinds that serve no channel, and a held credential
  // whose channels are all out of scope (its channel page shows Status only).
  const rows = scopeLoading
    ? []
    : all.filter(
        (c) => channelsOfKind(c.kind).length === 0 || outOfScope(c.kind),
      );
  const kinds = scopeLoading
    ? []
    : KINDS.filter(
        (k) =>
          channelsOfKind(k.value).length === 0 ||
          (outOfScope(k.value) && all.some((c) => c.kind === k.value)),
      );
  const editor = useCredentialEditor({
    slug,
    creds,
    rows,
    kinds,
    channelScoped: false,
    disabledReason: gate.disabledReason,
  });
  const names = (kind: string): string =>
    channelsOfKind(kind).map(channelLabel).join(" · ");
  // What each store link says: how many keys it holds and whether one is failing.
  const summary = (id: string): string => {
    const held = all.filter((c) => channelsOfKind(c.kind).includes(id));
    if (!held.length) return "";
    const failing = held.filter((c) => c.lastError).length;
    return ` · ${held.length} ${held.length === 1 ? "key" : "keys"}${
      failing ? ` · ${failing} failed` : ""
    }`;
  };

  // An old deep link to a store credential opens it on its channel's Setup.
  const moved = all.find((c) => c.id === openId && !rows.includes(c));
  const home = moved
    ? channelsOfKind(moved.kind).find((id) => channelInScope(features, id))
    : undefined;
  React.useEffect(() => {
    if (moved && home && !scopeLoading)
      navigate(`${r.channel(slug, home, "setup")}?credential=${moved.id}`, {
        replace: true,
      });
  }, [moved, home, scopeLoading, slug]);

  const channels = CREDENTIAL_CHANNELS.filter((id) =>
    channelInScope(features, id),
  );

  return (
    <CollectionTemplate
      header={
        <PageHeader
          title="Credentials"
          titleAside={
            creds.data ? (
              <span className="text-sm tabular-nums text-fg-muted">
                {rows.length}
              </span>
            ) : undefined
          }
          primaryAction={
            // One action, once: the empty state carries its own.
            rows.length ? (
              <Button
                iconStart={<Plus aria-hidden />}
                disabledReason={gate.disabledReason}
                onClick={editor.create}
              >
                Set credential…
              </Button>
            ) : undefined
          }
          refetching={creds.isFetching && !creds.isPending}
        />
      }
    >
      {!scopeLoading && channels.length ? (
        <section aria-labelledby="store-keys-title" className="space-y-2">
          <h2
            id="store-keys-title"
            className="text-lg font-semibold text-fg-strong"
          >
            Store keys
          </h2>
          <p className="text-sm text-fg-muted">
            Each store's keys are set on its channel's Setup tab.
          </p>
          <ul className="flex flex-wrap gap-x-5 gap-y-1">
            {channels.map((id) => (
              <li key={id}>
                <Link
                  to={r.channel(slug, id, "setup")}
                  className="inline-flex min-h-6 items-center text-accent-fg underline underline-offset-4"
                >
                  {channelLabel(id)}
                  {summary(id)}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <CredentialTable
        editor={editor}
        creds={creds}
        rows={rows}
        id="credentials"
        caption="Credentials"
        channelColumn
        filters
        pending={scopeLoading}
        outOfScope={(c) =>
          outOfScope(c.kind)
            ? `${names(c.kind)} ${channelsOfKind(c.kind).length > 1 ? "aren't" : "isn't"} in ${name}'s platforms. Delete the key, or add a platform it serves.`
            : undefined
        }
        kindChannels={names}
        empty={
          <EmptyState
            kind="first-run"
            title="No other credentials yet"
            description="Sentry needs its integration secret to send alerts that open halt candidates."
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

      <p className="text-sm text-fg-muted">
        Store controls are on each channel's Setup tab, under{" "}
        <Link to={r.channels(slug)}>Channels</Link>.{" "}
        <a
          className="py-1 text-accent-fg underline underline-offset-4"
          href={docsUrl("storeConnections")}
          target="_blank"
          rel="noreferrer"
        >
          About store connections
        </a>
      </p>

      {editor.dialogs}
    </CollectionTemplate>
  );
}
