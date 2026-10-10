/**
 * Fills the user record's `overrideEditor` slot (I-12 hand-off; `userSlots.ts`) with U-03's
 * account override editor, once, at module load. The Core section's page module imports this
 * file for that side effect, so the slot is filled before any user record renders.
 *
 * The editor itself (the managed-payload editor and the catalog validator) loads lazily, on the
 * first record whose product runs Config, so the Core chunk does not carry it.
 */

import * as React from "react";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { userSlots, type UserSlotProps } from "../model/userSlots.js";

const Editor = React.lazy(() => import("./accountOverrides.js"));

export function AccountOverridesSlot(props: UserSlotProps): React.ReactElement {
  return (
    <React.Suspense
      fallback={
        <div aria-busy="true" className="space-y-3">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-32 w-full" />
        </div>
      }
    >
      <Editor {...props} />
    </React.Suspense>
  );
}

userSlots.overrideEditor = AccountOverridesSlot;
