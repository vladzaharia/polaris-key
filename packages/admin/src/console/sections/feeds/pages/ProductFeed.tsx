/**
 * A product's feed page exists because a package is declared: a deep link to an ecosystem the
 * product does not declare says so, with the declaration, and never offers to set the feed up by
 * hand (F-34.7).
 */

import * as React from "react";
import type { FeedEcosystem } from "../../../../api.js";
import { PageSkeleton } from "../../../../ui/Skeleton.js";
import { useProduct } from "../../../data/hooks.js";
import { useFeedsOverview } from "../data.js";
import { ECOSYSTEM_LABELS, type FeedScope } from "../model/model.js";
import { FeedPage } from "./FeedPage.js";
import { UndeclaredFeed } from "./PackagesEmpty.js";
import { provisionedFeeds } from "./PackagesOverview.js";

export function ProductFeed({
  slug,
  scope,
  eco,
  tab,
}: {
  slug: string;
  scope: FeedScope;
  eco: FeedEcosystem;
  tab?: string;
}): React.ReactElement {
  const overview = useFeedsOverview(scope);
  const product = useProduct(slug);
  if (overview.isPending)
    return <PageSkeleton template="record" label="feed" />;
  const declared =
    overview.data === undefined ||
    provisionedFeeds(overview.data).some((f) => f.ecosystem === eco);
  if (!declared)
    return (
      <UndeclaredFeed
        scope={scope}
        slug={slug}
        name={product.data?.name ?? slug}
        eco={eco}
        ecoLabel={ECOSYSTEM_LABELS[eco]}
      />
    );
  return <FeedPage scope={scope} eco={eco} tab={tab} />;
}
