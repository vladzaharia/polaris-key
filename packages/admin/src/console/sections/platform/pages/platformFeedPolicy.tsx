/**
 * Package feeds policy in Storefront and hosting (ST-09; moved from the Package feeds page).
 * Per ecosystem, the kill switch and the size ceiling, as rows of the settings engine. Both rows
 * of an ecosystem write the one policy record, so each carries its version and the page refetches
 * after a save. Viewing needs Platform access; changing needs Platform edit.
 */

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { FeedEcosystem, FeedPolicy } from "../../../../api.js";
import { fromSeconds } from "../../../../lib/format.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { Section } from "../../../../ui/Section.js";
import { PageSkeleton } from "../../../../ui/Skeleton.js";
import { SourceBadge } from "../../../../ui/SourceBadge.js";
import { SettingRow } from "../../../../ui/settings/SettingRow.js";
import type { SettingSpec } from "../../../../ui/settings/model.js";
import { toast } from "../../../../ui/toast.js";
import { useWriteGate } from "../../../access/useCan.js";
import { mutate } from "../../../data/mutations.js";
import { qk } from "../../../data/queries.js";
import { useFeedsOverview } from "../../feeds/data.js";
import { isConflict } from "./platformSettingRow.js";

const PLATFORM = { kind: "platform" } as const;
const GIB = 1024 ** 3;

const CEILING_SPEC: SettingSpec = {
  kind: "integer",
  unit: "bytes",
  min: 1024,
  max: 5 * GIB,
};

export function FeedPolicySection(): React.ReactElement | null {
  const query = useFeedsOverview(PLATFORM);
  const rows = (query.data?.policies ?? []).filter((p) => p.policy !== null);
  const head = {
    variant: "settings" as const,
    id: "platform-feeds-policy",
    headingLevel: 3 as const,
    title: "Package feeds",
    description:
      "Each ecosystem's switch and size ceiling apply to every product's feed of it.",
  };
  if (query.isPending)
    return (
      <Section {...head}>
        <PageSkeleton template="form" label="package feeds policy" />
      </Section>
    );
  if (query.isError)
    return (
      <Section {...head}>
        <ErrorState
          compact
          error={query.error}
          onRetry={() => void query.refetch()}
          context={{ area: "distribution", thing: "Package feeds policy" }}
        />
      </Section>
    );
  if (rows.length === 0) return null;
  return (
    <Section {...head}>
      {rows.map((p) => (
        <PolicyRows
          key={p.ecosystem}
          eco={p.ecosystem}
          label={p.label}
          policy={p.policy!}
        />
      ))}
    </Section>
  );
}

function PolicyRows({
  eco,
  label,
  policy,
}: {
  eco: FeedEcosystem;
  label: string;
  policy: FeedPolicy;
}): React.ReactElement {
  const queryClient = useQueryClient();
  const write = useWriteGate("platform");
  const reload = () =>
    queryClient.refetchQueries({ queryKey: qk.pkgFeeds(PLATFORM) });
  const source = policy.updatedBy ? (
    <SourceBadge
      source="runtime"
      by={policy.updatedBy}
      at={fromSeconds(policy.updatedAt)}
    />
  ) : (
    <SourceBadge source="default" />
  );
  const common = {
    version: policy.version,
    source,
    locked: write.allowed ? undefined : write.disabledReason,
    isConflict,
    reload,
  };
  return (
    <>
      <SettingRow
        {...common}
        id={`platform-feeds-${eco}-enabled`}
        settingKey={`feeds.policy.${eco}.enabled`}
        label={`Serve ${label}`}
        help={
          policy.enabled
            ? `On: each owner's ${label} feed serves as its own settings say.`
            : `Off: every owner's ${label} feed answers not-found.`
        }
        spec={{ kind: "switch" }}
        confirm={{ on: "L0", off: "L2" }}
        commit="immediate"
        value={policy.enabled ? "on" : "off"}
        consequences={(to) =>
          to === "off"
            ? [
                `Every product's ${label} feed, the platform's included, answers not-found within 30 seconds.`,
                "Settings, packages and versions are kept; the feeds answer again when the ecosystem is served.",
              ]
            : [`Every ${label} feed serves as its own settings say.`]
        }
        save={(value, ctx) =>
          mutate("saveFeedPolicy", eco, {
            expectedVersion: ctx.expectedVersion,
            enabled: value === "on",
          })
        }
        onSaved={(_res, done) =>
          toast.success(
            `${label} ${done.value === "on" ? "served" : "stopped"}`,
          )
        }
      />
      <SettingRow
        {...common}
        id={`platform-feeds-${eco}-ceiling`}
        settingKey={`feeds.policy.${eco}.ceiling`}
        label={`${label} size ceiling`}
        help={`No ${label} feed may accept a larger package, whatever its own limit.`}
        spec={CEILING_SPEC}
        confirm={{ up: "L0", down: "L0" }}
        commit="explicit"
        value={policy.maxPackageBytesCeiling}
        bounds="Up to 5,120 MiB."
        consequences={() => [
          `New ${label} publishes above the ceiling are refused.`,
        ]}
        save={(value, ctx) =>
          mutate("saveFeedPolicy", eco, {
            expectedVersion: ctx.expectedVersion,
            maxPackageBytesCeiling: value as number,
          })
        }
        onSaved={() => toast.success(`${label} size ceiling saved`)}
      />
    </>
  );
}
