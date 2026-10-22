/**
 * Platform → Deployment's Database and Platform activity panels. Split out of `../index.tsx`.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type PlatformActivityItem } from "../../../../api.js";
import { formatCount, fromSeconds } from "../../../../lib/format.js";
import { Button } from "../../../../ui/Button.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { Timeline, TimelineItem } from "../../../../ui/Timeline.js";
import { Panel } from "../../../templates/Dashboard.js";
import { qk } from "../../../data/queries.js";
import { useMorePages } from "./platformDeployParts.js";

/** The verb phrase of a platform action; an action without one reads as its code. */
const ACTION_VERBS: Record<string, string> = {
  "kek.reseal": "re-sealed values under KEK",
  "platform.setting.set": "changed platform setting",
  "platform.setting.revert": "reverted platform setting",
  "feed.bootstrap": "set up the platform's package feeds",
  "feed.policy.update": "changed the platform policy of feed",
  // LX-08: the deploy hook's licensing catch-up pass.
  "licensing.catch_up": "ran the licensing catch-up",
};

/**
 * Platform activity (A-12): `platform_audit`, the admin actions that belong to no product (a KEK
 * re-seal sweep, a platform settings write). Newest first, with Load more.
 */
export function ActivityPanel(): React.ReactElement {
  const activity = useQuery({
    queryKey: qk.platformActivity(),
    queryFn: () => api.platformActivity(),
  });
  const more = useMorePages<PlatformActivityItem>(
    (cursor) => api.platformActivity(cursor),
    activity.data,
  );
  return (
    <Panel title="Platform activity">
      {activity.isPending ? (
        <div aria-hidden className="pk-skeleton-group space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-3">
              <div className="pk-skeleton size-6 shrink-0 rounded-full" />
              <div className="pk-skeleton h-4 flex-1 rounded-md" />
              <div className="pk-skeleton h-3 w-16 rounded-md" />
            </div>
          ))}
        </div>
      ) : activity.isError && !activity.data ? (
        <ErrorState
          compact
          error={activity.error}
          onRetry={() => void activity.refetch()}
        />
      ) : more.items.length === 0 ? (
        <EmptyState
          kind="first-run"
          variant="inline"
          title="No platform activity yet"
          description="Actions on the instance as a whole, such as a KEK re-seal sweep, are recorded here with who ran them."
        />
      ) : (
        <>
          <Timeline<PlatformActivityItem>
            label="Platform activity"
            items={more.items}
            getKey={(a) => a.id}
            getTime={(a) => fromSeconds(a.at)}
            loadMore={{
              onLoadMore: more.loadMore,
              hasMore: more.hasMore,
              loading: more.loading,
            }}
            renderItem={(a) => (
              <TimelineItem
                actor={
                  a.actor.name || a.actor.email
                    ? { name: a.actor.name || a.actor.email }
                    : "system"
                }
                verb={ACTION_VERBS[a.action] ?? a.action}
                target={
                  a.target ? (
                    <span className="font-mono text-xs">{a.target.id}</span>
                  ) : undefined
                }
                at={fromSeconds(a.at)}
                summary={a.summary || undefined}
              />
            )}
          />
          {more.error ? (
            <ErrorState compact error={more.error} onRetry={more.loadMore} />
          ) : null}
        </>
      )}
    </Panel>
  );
}
