/**
 * Settings → General → Storage: what the nightly blob collector would remove (read-only; moved out
 * of `Settings.tsx` by ST-08 to keep it under its page budget).
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type BlobGcDryRun } from "../../../../api.js";
import {
  formatCount,
  formatDuration,
  fromSeconds,
} from "../../../../lib/format.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { Timestamp } from "../../../../ui/Timestamp.js";
import { coreBReads } from "../data.js";
import { SettingsRow, SettingsSection } from "../../../templates/Settings.js";

export function StorageSection({ slug }: { slug: string }): React.ReactElement {
  const gc = useQuery(coreBReads.blobGc(slug));
  return (
    <SettingsSection
      id="settings-storage"
      title="Storage"
      description="What the nightly blob collector would remove. Nothing here deletes anything."
    >
      {gc.isPending ? (
        <div className="px-5 py-4">
          <Skeleton className="h-16 w-full" />
        </div>
      ) : gc.isError ? (
        <div className="px-5 py-4">
          <ErrorState
            compact
            error={gc.error}
            onRetry={() => void gc.refetch()}
          />
        </div>
      ) : (
        <StorageFacts dry={gc.data} />
      )}
    </SettingsSection>
  );
}

function StorageFacts({ dry }: { dry: BlobGcDryRun }): React.ReactElement {
  const drops = dry.drops.packObject + dry.drops.packUpload;
  return (
    <>
      <SettingsRow label="Collector">
        {dry.enabled ? (
          <StatusPill tone="success">
            On · {formatDuration(dry.graceSeconds * 1000).replace(/^for /, "")}{" "}
            grace
          </StatusPill>
        ) : (
          <StatusPill tone="neutral">Off on this deployment</StatusPill>
        )}
      </SettingsRow>
      <SettingsRow
        label="Eligible for removal"
        help={`${formatCount(dry.drops.packObject)} pack objects, ${formatCount(dry.drops.packUpload)} abandoned uploads${dry.restores.count ? `; ${formatCount(dry.restores.count)} would be restored` : ""}.`}
      >
        <span className="tabular-nums">
          {`${formatCount(drops)}${dry.drops.truncated ? "+" : ""} ${drops === 1 ? "object" : "objects"}`}
        </span>
      </SettingsRow>
      <SettingsRow label="Earliest deletion">
        {dry.earliestDeletion ? (
          <Timestamp at={fromSeconds(dry.earliestDeletion)} format="detail" />
        ) : (
          <span className="text-fg-muted">None scheduled</span>
        )}
      </SettingsRow>
    </>
  );
}
