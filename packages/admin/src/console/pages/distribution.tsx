import * as React from "react";
import { Distribution } from "../../views/Distribution.js";
import { DistributionMatrixView } from "../../views/distribution/Matrix.js";
import { UpdateHealthView } from "../../views/distribution/UpdateHealth.js";
import type { SectionPageProps } from "./types.js";

/**
 * Distribution: the legacy views at their new URLs, unchanged until chunk 9. Rollouts mounts
 * today's Distribution overview, which holds the rollouts table (and the chain and hooks cards
 * that chunk 9 moves to Services or removes).
 */
export default function DistributionPages({
  route,
}: SectionPageProps): React.ReactElement | null {
  const { slug } = route;
  switch (route.page) {
    case "matrix":
      return <DistributionMatrixView slug={slug} />;
    case "rollouts":
      return <Distribution slug={slug} />;
    case "health":
      return <UpdateHealthView slug={slug} />;
    default:
      return null;
  }
}
