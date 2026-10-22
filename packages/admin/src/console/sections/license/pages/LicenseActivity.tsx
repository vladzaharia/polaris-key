/**
 * The license record's **Activity** tab: this license's slice of the product's audit log, filtered
 * on the server by target (`targetKind=license&targetId=<id>`, A-2). The same feed and rows as
 * Core → Activity, newest first, paged by cursor.
 */

import * as React from "react";
import type { ActivityItem } from "../../../../api.js";
import { fromSeconds } from "../../../../lib/format.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { PageSkeleton } from "../../../../ui/Skeleton.js";
import { Timeline, TimelineItem } from "../../../../ui/Timeline.js";
import { r } from "../../../routes.js";
import { Link } from "../../../router.js";
import { Button } from "../../../../ui/Button.js";
import {
  actorName,
  ActivityTarget,
  useActivityFeed,
} from "../../core/pages/Activity.js";
import { verbFor } from "../../core/model/activityVerbs.js";

export function LicenseActivity({
  slug,
  id,
}: {
  slug: string;
  id: string;
}): React.ReactElement {
  const filters = React.useMemo(
    () => ({ targetKind: "license", targetId: id }),
    [id],
  );
  const feed = useActivityFeed(slug, filters);
  const items = React.useMemo(
    () => feed.data?.pages.flatMap((p) => p.items) ?? [],
    [feed.data],
  );
  if (feed.isPending) return <PageSkeleton template="table" label="activity" />;
  if (feed.isError)
    return (
      <ErrorState error={feed.error} onRetry={() => void feed.refetch()} />
    );
  if (items.length === 0)
    return (
      <EmptyState
        kind="first-run"
        title="No activity yet"
        description="Changes to this license appear here with who made them."
      />
    );
  return (
    <div className="space-y-4">
      <Timeline<ActivityItem>
        label="License activity"
        headingLevel={2}
        items={items}
        getKey={(i) => i.id}
        getTime={(i) => fromSeconds(i.at)}
        renderItem={(i) => (
          <TimelineItem
            actor={i.actor.sub ? { name: actorName(i) } : "system"}
            verb={verbFor(i.action)}
            target={<ActivityTarget slug={slug} item={i} />}
            at={fromSeconds(i.at)}
            summary={
              <span className="block space-y-1">
                {i.summary ? (
                  <span className="block whitespace-pre-wrap">{i.summary}</span>
                ) : null}
                <span className="block font-mono text-xs text-fg-subtle">
                  {i.action}
                </span>
              </span>
            }
          />
        )}
        loadMore={{
          onLoadMore: () => void feed.fetchNextPage(),
          hasMore: feed.hasNextPage,
          loading: feed.isFetchingNextPage,
        }}
      />
      <Button asChild variant="link" size="sm">
        <Link to={r.activity(slug, { kind: "license", target: id })}>
          Open in Activity
        </Link>
      </Button>
    </div>
  );
}
