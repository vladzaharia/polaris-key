import * as React from "react";
import { CommercePage } from "../distribution/pages/CommercePage.js";
import { CommerceOverviewPage } from "./CommerceOverview.js";
import type { SectionPageProps } from "../../pages/types.js";

/** Commerce (CM-29): the App Store in-app purchases page, moved from Distribution. */
export default function CommercePages({
  route,
}: SectionPageProps): React.ReactElement | null {
  if (route.page === "commerce-overview")
    return <CommerceOverviewPage slug={route.slug} />;
  return route.page === "commerce" ? <CommercePage slug={route.slug} /> : null;
}
