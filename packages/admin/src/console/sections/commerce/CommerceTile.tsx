import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { formatCount } from "../../../lib/format.js";
import { r } from "../../routes.js";
import { FeatureCard } from "../core/components/TileFrame.js";
import { reads } from "../../data/reads.js";

/** Commerce's card on the Overview (CM-29): its storefronts and the store purchases they brought. */
export function CommerceTile({
  slug,
  attention = 0,
}: {
  slug: string;
  attention?: number;
}): React.ReactElement {
  const services = useQuery(reads.services(slug));
  const facts = services.data?.facts.commerce;
  const grants = facts?.storeGrants ?? 0;
  return (
    <FeatureCard
      service="commerce"
      href={r.commerceOverview(slug)}
      attention={attention}
      loading={services.isPending}
      error={services.isError ? services.error : undefined}
      onRetry={() => void services.refetch()}
      number={
        facts && facts.storefronts > 0
          ? formatCount(facts.storefronts)
          : undefined
      }
      unit={
        facts && facts.storefronts > 0
          ? facts.storefronts === 1
            ? "storefront"
            : "storefronts"
          : undefined
      }
      foot={
        facts
          ? facts.storefronts === 0
            ? "No storefront yet"
            : `${formatCount(grants)} store ${grants === 1 ? "purchase" : "purchases"}`
          : undefined
      }
    />
  );
}
