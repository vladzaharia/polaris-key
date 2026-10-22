import * as React from "react";
import { r } from "../../routes.js";
import { FeatureCard } from "../core/components/TileFrame.js";

/** Commerce's card on the Overview (CM-29); CM-23 adds the offers and purchases counts. */
export function CommerceTile({
  slug,
  attention = 0,
}: {
  slug: string;
  attention?: number;
}): React.ReactElement {
  return (
    <FeatureCard
      service="commerce"
      href={r.commerceOverview(slug)}
      attention={attention}
      foot="Store purchases that give licenses and add-ons"
    />
  );
}
