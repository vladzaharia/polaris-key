/** Package feeds off for a product: what is refused, and Turn on (F-34.8 reworks it). */

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../../api.js";
import { docsUrl } from "../../../../lib/docsLinks.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { formatCount, fromSeconds } from "../../../../lib/format.js";
import { Button } from "../../../../ui/Button.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { PageHeader } from "../../../../ui/PageHeader.js";
import { Timestamp } from "../../../../ui/Timestamp.js";
import { toast } from "../../../../ui/toast.js";
import { qk } from "../../../data/queries.js";
import { mutate } from "../../../data/mutations.js";
import { useFeedsOverview } from "../data.js";
import { ECOSYSTEM_ICONS, ECOSYSTEM_LABELS } from "../model/model.js";

export function PackageFeedsOff({
  slug,
  name,
}: {
  slug: string;
  name: string;
}): React.ReactElement {
  const queryClient = useQueryClient();
  const sw = useQuery({
    queryKey: qk.packageFeedsSwitch(slug),
    queryFn: () => api.packageFeeds(slug),
  });
  const overview = useFeedsOverview({ kind: "product", slug });
  // Only feeds that were set up: what the registry refuses now and keeps for later.
  const feeds = (overview.data?.feeds ?? []).filter((f) => f.configured);
  const [busy, setBusy] = React.useState(false);
  const [failure, setFailure] = React.useState<unknown>(null);
  const turnOn = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      const result = await mutate("savePackageFeeds", slug, {
        enabled: true,
        expectedVersion: sw.data?.packageFeeds.version ?? 0,
      });
      queryClient.setQueryData(qk.packageFeedsSwitch(slug), {
        packageFeeds: result.packageFeeds,
      });
      toast.success("Package feeds turned on");
    } catch (e) {
      setFailure(e);
    } finally {
      setBusy(false);
    }
  };
  const at = sw.data?.packageFeeds.updatedAt;
  const failureCopy = failure ? errorCopy(failure) : null;
  return (
    <div className="space-y-6">
      <PageHeader title="Packages" />
      <EmptyState
        kind="first-run"
        service="distribution"
        title={`Package feeds are off for ${name}`}
        description={
          <>
            Declared packages aren't served: installs and CI publishes on its
            feeds are refused.
            {at ? (
              <>
                {" "}
                Turned off on{" "}
                <Timestamp at={fromSeconds(at)} format="absolute" />.
              </>
            ) : null}{" "}
            Nothing was deleted.
          </>
        }
        primaryAction={
          <Button onClick={() => void turnOn()} disabled={busy}>
            Turn on package feeds
          </Button>
        }
        docs={docsUrl("packageFeeds")}
      />
      {failureCopy ? (
        <p role="alert" className="text-sm text-danger">
          {failureCopy.title}
        </p>
      ) : null}
      {feeds.length ? (
        <ul
          aria-label="Feeds refusing installs and publishes"
          className="divide-y divide-border rounded-lg border border-border text-fg-muted"
        >
          {feeds.map((f) => {
            const Icon = ECOSYSTEM_ICONS[f.ecosystem];
            return (
              <li
                key={f.ecosystem}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm"
              >
                <Icon aria-hidden className="size-4 shrink-0" />
                <span className="font-medium">
                  {ECOSYSTEM_LABELS[f.ecosystem]}
                </span>
                <span>
                  {f.packages
                    ? `${formatCount(f.packages)} ${f.packages === 1 ? "package" : "packages"}`
                    : "no package yet"}
                </span>
                <span className="ms-auto text-xs">
                  Refusing installs and publishes
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
