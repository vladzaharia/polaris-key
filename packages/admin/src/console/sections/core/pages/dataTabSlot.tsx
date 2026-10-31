/**
 * Fills the user record's `dataTab` slot (U-11a; `userSlots.ts`) with Cloud Sync's Data tab, once,
 * at module load. The Core section's page module imports this file for that side effect, so the
 * slot is filled before any user record renders (the record is Core's; Cloud Sync's own chunk
 * loads only on its routes and could not fill it in time).
 *
 * The tab itself loads lazily, on the first record whose Data tab opens.
 */

import * as React from "react";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { userSlots, type UserSlotProps } from "../model/userSlots.js";

const Tab = React.lazy(() =>
  import("../../sync/dataTab/index.js").then((m) => ({
    default: m.SyncDataTab,
  })),
);

export function DataTabSlot(props: UserSlotProps): React.ReactElement {
  return (
    <React.Suspense
      fallback={
        <div aria-busy="true" className="pk-skeleton-group space-y-6">
          <Skeleton className="h-32 w-full rounded-xl" />
          <Skeleton className="h-48 w-full rounded-xl" />
        </div>
      }
    >
      <Tab {...props} />
    </React.Suspense>
  );
}

userSlots.dataTab = DataTabSlot;
