/**
 * The tier record (licenses.tiers): one card of three groups, Duration, Limits and Profile
 * (LX-44), sending only what changed (TIR-4) with nullable numbers (TIR-1) and min ≤ max on the
 * client (TIR-3). One save bar says how many licenses the change reaches. Delete is disabled
 * with its reason while the tier is used. The licenses on a tier are the filtered Licenses list.
 */

import * as React from "react";
import { TiersPage } from "./TiersPage.js";

/** `#/p/<slug>/license/tiers/<id>`: the Tiers page with that tier open. */
export function TierRecord({
  slug,
  id,
}: {
  slug: string;
  id: string;
  tab?: string;
}): React.ReactElement {
  return <TiersPage slug={slug} selectedId={id} />;
}
