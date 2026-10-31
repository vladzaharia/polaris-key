/**
 * The seams on a user's record that later packages fill (I-12 hand-off):
 *
 *   - `dataTab`: the Data tab's content (U-11a). The tab is shown only while Cloud Sync is on AND
 *     this is set, so the record never shows an empty or "coming soon" tab;
 *   - `overrideEditor`: the account override editor (U-03), drawn on Overview while Config is on;
 *   - `cloudSyncOn`: whether the product runs Cloud Sync (`services.sync.enabled`).
 *
 * A package fills its slot by assigning it here, once, at module load; nothing else in the record
 * changes. The slot is filled from the Core section's chunk (`dataTabSlot.tsx`, `accountOverridesSlot.tsx`),
 * which a user record always loads: a slot filled from a section that loads only on its own routes
 * would stay empty on the record.
 */

import type * as React from "react";
import type { ProductDetail } from "../../../../api.js";

export interface UserSlotProps {
  slug: string;
  /** This product's pairwise subject: the only user id a slot ever receives. */
  subject: string;
}

export interface UserSlots {
  dataTab: React.ComponentType<UserSlotProps> | null;
  overrideEditor: React.ComponentType<UserSlotProps> | null;
  cloudSyncOn: (product: ProductDetail | undefined) => boolean;
}

export const userSlots: UserSlots = {
  dataTab: null,
  overrideEditor: null,
  cloudSyncOn: (product) => product?.services?.sync?.enabled === true,
};
