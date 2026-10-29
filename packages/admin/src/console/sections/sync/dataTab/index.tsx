/**
 * Users → Data (U-11a): what Cloud Sync holds for one person of this product, read-only. It is the
 * user record's `dataTab` slot (`core/pages/dataTabSlot.tsx`), shown while Cloud Sync is on.
 *
 * One read (`GET …/sync/subjects/<subject>`, audited on the server): sizes and names, never a
 * value. The sections are Storage and Settings (Collections and Encryption follow). Operators cannot restore
 * or edit here (D-11); the one write, delete, arrives with its own confirmation.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { HttpError, type SyncSubjectResponse } from "../../../../api.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { useLoadingAnnouncement } from "../../../../ui/loading.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import type { UserSlotProps } from "../../core/model/userSlots.js";
import { syncSubjectQuery } from "../data.js";
import { SettingsTable } from "./SettingsTable.js";
import { Storage } from "./Storage.js";

export type SubjectData = Extract<SyncSubjectResponse, { enabled: true }>;

/** Nothing stored and no key: the person has not synced yet (a key ring alone still shows). */
export function nothingSynced(data: SubjectData): boolean {
  return data.empty && data.collections.length === 0 && data.ring === null;
}

export function SyncDataTab({
  slug,
  subject,
}: UserSlotProps): React.ReactElement {
  const q = useQuery(syncSubjectQuery(slug, subject));
  useLoadingAnnouncement("Cloud Sync data", q.isPending);

  if (q.isPending)
    // The skeleton waits out the grace (`pk-skeleton-group`), so a fast read never flashes it.
    return (
      <div aria-busy="true" className="pk-skeleton-group space-y-6">
        <p role="status" className="sr-only">
          Loading Cloud Sync data
        </p>
        <Skeleton className="h-28 w-full rounded-xl" />
        <Skeleton className="h-56 w-full rounded-xl" />
      </div>
    );
  if (q.isError)
    return (
      <ErrorState
        error={q.error}
        onRetry={() => void q.refetch()}
        // A refusal reads as "You don't have access", not as a failed load.
        {...(q.error instanceof HttpError && q.error.status === 403
          ? {}
          : { thing: "Cloud Sync data" })}
        context={{ read: true, thing: "Cloud Sync data" }}
      />
    );
  const data = q.data;
  if (!data.enabled)
    return (
      <EmptyState
        kind="first-run"
        headingLevel={2}
        title="Cloud Sync is off"
        description="Turn it on in Features to see a person's synced data."
      />
    );
  if (nothingSynced(data))
    return (
      <EmptyState
        kind="first-run"
        headingLevel={2}
        title="Nothing synced yet"
        description="Their data appears here after they sign in and sync."
      />
    );
  return (
    <div className="space-y-6">
      <Storage slug={slug} data={data} />
      <SettingsTable data={data} />
    </div>
  );
}
