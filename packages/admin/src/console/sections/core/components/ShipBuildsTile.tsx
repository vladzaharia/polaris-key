import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../../api.js";
import { formatCount } from "../../../../lib/format.js";
import { ACCESS_LABELS } from "../../../../lib/labels.js";
import { qk } from "../../../data/queries.js";
import { useReleaseHealth } from "../../release/data.js";
import { r } from "../../../routes.js";
import { FeatureCard } from "./TileFrame.js";

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
 * Ship builds is one feature and one card (BRAND §14.4), like the sidebar's one group: the version
 * on stable (else the newest release) as its number, the rollouts live (Distribution on) and the
 * updater's state (Update on) as its foot.
 */
export function ShipBuildsTile({
  slug,
  distribution,
  update,
  attention = 0,
}: {
  slug: string;
  distribution: boolean;
  update: boolean;
  /** Items the product's attention read holds for this feature. */
  attention?: number;
}): React.ReactElement {
  const store = useQuery({
    queryKey: qk.releases(slug),
    queryFn: () => api.releases(slug),
  });
  const health = useReleaseHealth(slug);
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
  const live = list.filter((x) => x.state === "active").length;
  const failed = [store, rollouts, feed].find((q) => q.isError);
  const version = stableVersion ?? latest?.version;
  const foot = [
    stableVersion && stableVersion !== latest?.version && latest
      ? `${latest.version} newest`
      : null,
    rollouts.data
      ? `${formatCount(live)} ${live === 1 ? "rollout" : "rollouts"} live`
      : null,
    feed.data && !feed.data.hidden
      ? `In-app updates: ${ACCESS_LABELS[feed.data.metadataAccess] ?? feed.data.metadataAccess}`
      : null,
  ].filter((x): x is string => x !== null);
  return (
    <FeatureCard
      service="release"
      href={r.releases(slug)}
      attention={attention + (health.data && !health.data.healthy ? 1 : 0)}
      loading={store.isPending}
      error={failed?.error}
      onRetry={() => void failed?.refetch()}
      number={version}
      unit={stableVersion ? "stable" : undefined}
      foot={
        (version ? foot : ["No releases yet", ...foot]).join(" · ") || undefined
      }
    />
  );
}
