/**
 * Platform → Settings → Recently changed: the settings writes of the platform trail (split by ST-09).
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  type PlatformActivityItem,
  type PlatformSetting,
} from "../../../../api.js";
import { fromSeconds } from "../../../../lib/format.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { Timeline, TimelineItem } from "../../../../ui/Timeline.js";
import {
  fetchSettingsHistory,
  formatPlatformValue,
  type HistoryPage,
} from "./platformSettingRow.js";
import { qk } from "../../../data/queries.js";
import { SettingsSection } from "../../../templates/Settings.js";

function fetchFirstHistoryPage(): Promise<HistoryPage> {
  return fetchSettingsHistory(null);
}

function snapshotValue(raw: unknown): unknown {
  return raw && typeof raw === "object" && "effective" in raw
    ? (raw as { effective: unknown }).effective
    : undefined;
}

export function HistorySection({
  settings,
}: {
  settings: PlatformSetting[];
}): React.ReactElement {
  const history = useQuery({
    queryKey: qk.platformSettingsHistory(),
    queryFn: fetchFirstHistoryPage,
  });
  const [extra, setExtra] = React.useState<HistoryPage | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const first = history.data;
  React.useEffect(() => {
    setExtra(null);
    setError(null);
  }, [first]);
  const cursor = extra ? extra.nextCursor : (first?.nextCursor ?? null);
  const items = [...(first?.items ?? []), ...(extra?.items ?? [])];
  const loadMore = () => {
    if (!cursor || loading) return;
    setLoading(true);
    setError(null);
    fetchSettingsHistory(cursor)
      .then((page) =>
        setExtra((prev) => ({
          items: [...(prev?.items ?? []), ...page.items],
          nextCursor: page.nextCursor,
        })),
      )
      .catch((e: unknown) => setError(e))
      .finally(() => setLoading(false));
  };
  const byKey = new Map(settings.map((s) => [s.key, s]));
  const describe = (a: PlatformActivityItem): string | undefined => {
    const s = a.target ? byKey.get(a.target.id) : undefined;
    const before = snapshotValue(a.before);
    const after = snapshotValue(a.after);
    if (!s || before === undefined || after === undefined)
      return a.summary || undefined;
    return `${formatPlatformValue(s, before)} → ${formatPlatformValue(s, after)}`;
  };
  return (
    <SettingsSection id="platform-history" title="Recently changed">
      <div className="px-5 py-4">
        {history.isPending ? (
          <div aria-hidden className="pk-skeleton-group space-y-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center gap-4">
                <div className="pk-skeleton h-4 w-24 rounded-md" />
                <div className="pk-skeleton h-4 flex-1 rounded-md" />
              </div>
            ))}
          </div>
        ) : history.isError && !first ? (
          <ErrorState
            compact
            error={history.error}
            onRetry={() => void history.refetch()}
          />
        ) : items.length === 0 && !cursor ? (
          <EmptyState
            variant="inline"
            kind="first-run"
            title="No setting changes yet"
            description="Each change made here is recorded with who made it and the value before and after."
            docs="/docs/admin/activity/"
          />
        ) : (
          <>
            {items.length === 0 ? (
              <p className="text-sm text-fg-muted">
                No setting changes in the most recent platform activity.
              </p>
            ) : null}
            <Timeline<PlatformActivityItem>
              label="Setting changes"
              items={items}
              getKey={(a) => a.id}
              getTime={(a) => fromSeconds(a.at)}
              loadMore={{
                onLoadMore: loadMore,
                hasMore: cursor !== null,
                loading,
              }}
              renderItem={(a) => {
                const s = a.target ? byKey.get(a.target.id) : undefined;
                const change = describe(a);
                return (
                  <TimelineItem
                    actor={
                      a.actor.name || a.actor.email
                        ? { name: a.actor.name || a.actor.email }
                        : "system"
                    }
                    verb={
                      a.action === "platform.setting.revert"
                        ? "reverted"
                        : "changed"
                    }
                    target={
                      <span className="font-medium text-fg-strong">
                        {s?.label ?? a.target?.id ?? "a setting"}
                        {change ? (
                          <span className="ml-1 font-normal text-fg-muted">
                            ({change})
                          </span>
                        ) : null}
                      </span>
                    }
                    at={fromSeconds(a.at)}
                    summary={a.summary || undefined}
                  />
                );
              }}
            />
            {error ? (
              <ErrorState compact error={error} onRetry={loadMore} />
            ) : null}
          </>
        )}
      </div>
    </SettingsSection>
  );
}
