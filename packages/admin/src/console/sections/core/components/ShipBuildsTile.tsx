import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../../api.js";
import { formatCount } from "../../../../lib/format.js";
import { ACCESS_LABELS } from "../../../../lib/labels.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { qk } from "../../../data/queries.js";
import { r } from "../../../routes.js";
import { Big, Line, TileFrame } from "./TileFrame.js";

/** The product's newest app release that has not been yanked. */
export function latestAppRelease<
  T extends {
    deliverable: string;
    version: string;
    publishedAt: number | null;
    yank: unknown;
  },
>(releases: T[] | undefined): T | undefined {
  return (releases ?? [])
    .filter((x) => x.deliverable === "app" && !x.yank)
    .sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))[0];
}

/**
 * Ship builds is one feature and one tile (BRAND §14.4), like the sidebar's one group: the version
 * on stable, the rollouts live (Distribution on) and the updater's state (Update on) as its lines.
 */
export function ShipBuildsTile({
  slug,
  distribution,
  update,
}: {
  slug: string;
  distribution: boolean;
  update: boolean;
}): React.ReactElement {
  const store = useQuery({
    queryKey: qk.releases(slug),
    queryFn: () => api.releases(slug),
  });
  const health = useQuery({
    queryKey: qk.releaseHealth(slug),
    queryFn: () => api.releaseHealth(slug).then((x) => x.health),
  });
  const rollouts = useQuery({
    queryKey: qk.rollouts(slug),
    queryFn: () => api.rollouts(slug),
    enabled: distribution,
  });
  const feed = useQuery({
    queryKey: qk.feed(slug),
    queryFn: () => api.updateSettings(slug),
    enabled: update,
  });
  const latest = latestAppRelease(store.data?.releases);
  const stable = store.data?.channels.find((c) => c.channel === "stable");
  const stableVersion = stable
    ? store.data?.releases.find((x) => x.releaseId === stable.releaseId)
        ?.version
    : undefined;
  const list = rollouts.data?.rollouts ?? [];
  const count = (s: string) => list.filter((x) => x.state === s).length;
  const live = count("active");
  const failed = [store, rollouts, feed].find((q) => q.isError);
  return (
    <TileFrame
      service="release"
      badge={
        health.data && !health.data.healthy ? (
          <StatusPill tone="warning" size="sm">
            Needs setup
          </StatusPill>
        ) : undefined
      }
      href={r.releases(slug)}
      linkLabel="Releases"
      loading={store.isPending}
      error={failed?.error}
      onRetry={() => void failed?.refetch()}
    >
      <Big>
        {latest ? (
          <span className="font-mono">{latest.version}</span>
        ) : (
          "No releases"
        )}
      </Big>
      {stableVersion && stableVersion !== latest?.version ? (
        <Line>
          stable → <span className="font-mono">{stableVersion}</span>
        </Line>
      ) : null}
      {rollouts.data ? (
        <Line>
          {formatCount(live)} {live === 1 ? "rollout" : "rollouts"} live ·{" "}
          {formatCount(count("paused"))} paused · {formatCount(count("halted"))}{" "}
          halted
        </Line>
      ) : null}
      {feed.data ? (
        <Line>
          In-app updates:{" "}
          {ACCESS_LABELS[feed.data.metadataAccess] ?? feed.data.metadataAccess}
        </Line>
      ) : null}
    </TileFrame>
  );
}
