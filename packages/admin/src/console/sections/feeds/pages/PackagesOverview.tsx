/**
 * Packages, product scope (F-34.7, UX-33; mockups `packages.feeds` and `packages.feeds-empty`):
 * one card per provisioned feed, the access shown as a read-only chip, and an empty card when
 * the product declares no package. Nothing here turns a feed on: a feed exists because a package
 * is declared in `.pkey/release`. The off switch is F-34.8's, the cleanup notice F-36's; both
 * sit between the header and the cards.
 */

import * as React from "react";
import { Clock, Globe, Lock } from "lucide-react";
import type { FeedSummary, FeedsOverviewDto } from "../../../../api.js";
import { docsUrl } from "../../../../lib/docsLinks.js";
import { formatCount, fromSeconds } from "../../../../lib/format.js";
import { CodeBlock } from "../../../../ui/CodeBlock.js";
import { CopyButton } from "../../../../ui/CopyButton.js";
import { Button } from "../../../../ui/Button.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { Section } from "../../../../ui/Section.js";
import { Timestamp } from "../../../../ui/Timestamp.js";
import { Link } from "../../../router.js";
import {
  ECOSYSTEM_ICONS,
  ECOSYSTEM_LABELS,
  FEED_ACCESS_LABELS,
  OFF_REASONS,
  accessDisplayLabel,
  feedHref,
  type FeedScope,
} from "../model/model.js";
import { FeedStatusPill } from "./FeedsArea.js";

/** The feeds the product has: the ones a declared package provisioned. */
export function provisionedFeeds(data: FeedsOverviewDto): FeedSummary[] {
  return data.feeds.filter((f) => f.configured);
}

/** "Customers" or "Public", read-only; changing it is on the feed's Settings. */
function AccessChip({ feed }: { feed: FeedSummary }): React.ReactElement {
  const Icon = feed.accessMode === "public" ? Globe : Lock;
  const label = feed.accessDisplay
    ? accessDisplayLabel(feed.accessDisplay)
    : (FEED_ACCESS_LABELS[feed.accessMode] ?? feed.accessMode);
  return (
    <span
      data-access-chip=""
      className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-fg-muted"
    >
      <Icon aria-hidden className="size-3.5" />
      {label}
    </span>
  );
}

function FeedCard({
  scope,
  feed,
}: {
  scope: FeedScope;
  feed: FeedSummary;
}): React.ReactElement {
  const Icon = ECOSYSTEM_ICONS[feed.ecosystem];
  const label = ECOSYSTEM_LABELS[feed.ecosystem];
  const url = feed.baseUrl?.replace(/^https?:\/\//, "") ?? null;
  return (
    <Section
      title={
        <span className="inline-flex items-center gap-2">
          <Icon aria-hidden className="size-5 text-fg-muted" />
          {label}
        </span>
      }
      description={
        feed.baseUrl && url ? (
          <span className="inline-flex flex-wrap items-center gap-1">
            <span className="break-all font-mono text-xs">{url}</span>
            <CopyButton
              value={feed.baseUrl}
              label={`Copy the ${label} registry URL`}
              size="xs"
            />
          </span>
        ) : undefined
      }
      actions={<AccessChip feed={feed} />}
    >
      <div data-feed-card={feed.ecosystem} className="space-y-2 text-sm">
        {feed.status !== "enabled" ? (
          <p className="flex flex-wrap items-center gap-2">
            <FeedStatusPill feed={feed} />
            {feed.reason && feed.reason !== "feed-off" ? (
              <span className="text-fg-muted">{OFF_REASONS[feed.reason]}</span>
            ) : null}
          </p>
        ) : null}
        {feed.packages === 0 ? (
          <p className="flex items-center gap-2 text-fg-muted">
            <Clock aria-hidden className="size-4 shrink-0" />
            Waiting for the first package…
          </p>
        ) : (
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>
              {formatCount(feed.packages)}{" "}
              {feed.packages === 1 ? "package" : "packages"}
            </span>
            <span className="text-fg-muted">
              {formatCount(feed.versions)}{" "}
              {feed.versions === 1 ? "version" : "versions"}
            </span>
            {feed.lastPublishedAt ? (
              <span className="text-fg-muted">
                Last publish{" "}
                <Timestamp at={fromSeconds(feed.lastPublishedAt)} />
              </span>
            ) : null}
          </p>
        )}
        <Link
          to={feedHref(scope, feed.ecosystem)}
          className="inline-block text-accent underline-offset-2 hover:underline"
        >
          Open the {label} feed
        </Link>
      </div>
    </Section>
  );
}

/** One card per provisioned feed. */
export function FeedCards({
  scope,
  feeds,
}: {
  scope: FeedScope;
  feeds: FeedSummary[];
}): React.ReactElement {
  return (
    <ul aria-label="Package feeds" className="m-0 list-none space-y-4 p-0">
      {feeds.map((f) => (
        <li key={f.ecosystem}>
          <FeedCard scope={scope} feed={f} />
        </li>
      ))}
    </ul>
  );
}

/**
 * The quiet foot card (packages.feeds): the one place to turn the feeds off. The button opens
 * `TurnOffFeeds`, and Escape gives focus back to it.
 */
export function PackagesFoot({
  onTurnOff,
}: {
  onTurnOff: () => void;
}): React.ReactElement {
  return (
    <div
      data-feeds-foot=""
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-border px-4 py-3 text-sm"
    >
      <div>
        <p className="m-0 font-medium">Package feeds</p>
        <p className="m-0 text-fg-muted">Stops every install and CI publish.</p>
      </div>
      <Button variant="outline" onClick={onTurnOff}>
        Turn off package feeds
      </Button>
    </div>
  );
}

const PUBLISH =
  "pkey release publish --deliverable npm.sourcekit --dir dist/npm";

/** The `.pkey/release` declaration the empty card shows, in the product's own scope. */
export function declarationSnippet(slug: string): string {
  return [
    "deliverables:",
    "  npm.sourcekit:",
    "    kind: package",
    "    ecosystem: npm # npm | pypi | swift | maven | oci | godot",
    `    name: "@${slug}/source-kit"`,
    "    artifacts:",
    '      tarball: { match: "dist/npm/*.tgz" }',
  ].join("\n");
}

/** Nothing declared: how to declare a package, how to publish it, and nothing to turn on. */
export function PackagesEmpty({
  slug,
  name,
}: {
  slug: string;
  name: string;
}): React.ReactElement {
  return (
    <div className="space-y-4">
      <EmptyState
        kind="first-run"
        headingLevel={2}
        title={`${name} declares no packages yet`}
        description={
          <>
            Declare a package in <code>.pkey/release</code>; its feed appears
            here on the next resync.
          </>
        }
        docs={docsUrl("packageFeeds")}
      />
      <CodeBlock
        code={declarationSnippet(slug)}
        language="yaml"
        filename=".pkey/release"
      />
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-4 py-3">
        <code className="break-all font-mono text-xs">{PUBLISH}</code>
        <CopyButton
          value={PUBLISH}
          label="Copy the publish command"
          size="xs"
        />
      </div>
    </div>
  );
}
