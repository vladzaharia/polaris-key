/**
 * The two install cards at the foot of Packages (F-34.10, mockup `packages.feeds`): where people
 * install from. A person's machine runs `pkey feeds setup --write`; CI and servers run one
 * `pkey feeds setup` per feed, which prints a setup that reads a service token from an
 * environment variable. Every command comes from `@polaris-key/manifest`, the source the CLI
 * itself uses, and none shows a token: a private feed names the variable. A public feed needs no
 * token. Godot cannot be printed for CI, so its line links to the feed's Setup tab.
 */

import * as React from "react";
import {
  FEEDS_CI_TOKEN_ENV,
  FEEDS_SETUP_WRITE_COMMAND,
  feedsSetupCiCommand,
  feedsSetupCiSupported,
} from "@polaris-key/manifest";
import { useQuery } from "@tanstack/react-query";
import type { FeedSummary } from "../../../../api.js";
import { CopyButton } from "../../../../ui/CopyButton.js";
import { Section } from "../../../../ui/Section.js";
import { Timestamp } from "../../../../ui/Timestamp.js";
import { fromSeconds } from "../../../../lib/format.js";
import { Link } from "../../../router.js";
import { registryTokensQuery, useFeedDetail } from "../data.js";
import {
  ECOSYSTEM_LABELS,
  feedHref,
  tokensHref,
  type FeedScope,
} from "../model/model.js";

function Command({
  command,
  label,
}: {
  command: string;
  label: string;
}): React.ReactElement {
  return (
    <div
      data-install-command=""
      className="flex items-start gap-2 rounded-lg border border-border bg-surface-page px-3 py-2"
    >
      <span
        aria-hidden
        className="select-none font-mono text-xs leading-5 text-fg-subtle"
      >
        $
      </span>
      <code className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-xs leading-5">
        {command}
      </code>
      <CopyButton value={command} label={`Copy: ${label}`} size="xs" />
    </div>
  );
}

const linkCls =
  "inline-flex min-h-6 items-center text-accent-fg underline underline-offset-2";

/** One feed's CI command, with the namespace its settings hold. */
function CiCommand({
  scope,
  owner,
  feed,
}: {
  scope: FeedScope;
  owner: string;
  feed: FeedSummary;
}): React.ReactElement | null {
  const label = ECOSYSTEM_LABELS[feed.ecosystem];
  const detail = useFeedDetail(scope, feed.ecosystem);
  if (!feedsSetupCiSupported(feed.ecosystem))
    return (
      <p className="m-0 text-fg-muted">
        {label}: the editor reads a token in the feed&apos;s URL.{" "}
        <Link to={feedHref(scope, feed.ecosystem, "setup")} className={linkCls}>
          Open the {label} setup
        </Link>
      </p>
    );
  if (!detail.data) return null;
  const command = feedsSetupCiCommand(feed.ecosystem, owner, {
    namespace: detail.data.settings.namespace,
    ...(feed.accessMode === "public" ? {} : { tokenEnv: FEEDS_CI_TOKEN_ENV }),
  });
  return (
    <div className="space-y-1">
      <p className="m-0 text-xs font-medium text-fg-muted">{label}</p>
      <Command command={command} label={`${label} setup for CI`} />
    </div>
  );
}

/** Service token count and last use, or the way to make one. */
function TokenLine({
  scope,
  canCreate,
}: {
  scope: FeedScope;
  canCreate: boolean;
}): React.ReactElement | null {
  const q = useQuery(registryTokensQuery(scope));
  if (!q.data) return null;
  const active = (q.data.serviceTokens ?? []).filter(
    (t) => t.status === "active",
  );
  if (active.length === 0)
    return (
      <p className="m-0 text-fg-muted">
        No service token yet
        {canCreate ? (
          <>
            {" · "}
            <Link to={tokensHref(scope)} className={linkCls}>
              Create one
            </Link>
          </>
        ) : null}
      </p>
    );
  const used = active
    .map((t) => t.lastUsedAt)
    .filter((x): x is number => x !== null);
  const last = used.length ? Math.max(...used) : null;
  return (
    <p className="m-0 text-fg-muted">
      {active.length} service {active.length === 1 ? "token" : "tokens"}
      {" · "}
      {last === null ? (
        "never used"
      ) : (
        <>
          last used <Timestamp at={fromSeconds(last)} />
        </>
      )}
      {" · "}
      <Link to={tokensHref(scope)} className={linkCls}>
        Manage
      </Link>
    </p>
  );
}

export function InstallCards({
  scope,
  owner,
  feeds,
  canCreate,
}: {
  scope: FeedScope;
  /** The feed owner's slug. */
  owner: string;
  /** The provisioned feeds: one CI command each. */
  feeds: FeedSummary[];
  /** The member may create a service token. */
  canCreate: boolean;
}): React.ReactElement {
  const needsToken = feeds.some(
    (f) => feedsSetupCiSupported(f.ecosystem) && f.accessMode !== "public",
  );
  return (
    <div data-install-cards="" className="mt-4 grid grid-cols-1 gap-4">
      <Section title="Install on your machine">
        <div className="space-y-2 text-sm">
          <Command
            command={FEEDS_SETUP_WRITE_COMMAND}
            label="Install on your machine"
          />
          <p className="m-0 text-fg-muted">
            Signs in and sets up your package tools.
          </p>
        </div>
      </Section>
      <Section title="Install in CI and on servers">
        <div className="space-y-3 text-sm">
          {feeds.map((f) => (
            <CiCommand key={f.ecosystem} scope={scope} owner={owner} feed={f} />
          ))}
          {needsToken ? (
            <p className="m-0 text-fg-muted">
              Prints a setup that reads <code>{FEEDS_CI_TOKEN_ENV}</code>; set
              it to a service token.
            </p>
          ) : null}
          {needsToken ? (
            <TokenLine scope={scope} canCreate={canCreate} />
          ) : null}
        </div>
      </Section>
    </div>
  );
}
