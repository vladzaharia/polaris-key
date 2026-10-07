import * as React from "react";
import { AccessPage } from "../areas/distribution/AccessPage.js";
import { AppStorePage } from "../areas/distribution/AppStorePage.js";
import { CommercePage } from "../areas/distribution/CommercePage.js";
import { CredentialsPage } from "../areas/distribution/CredentialsPage.js";
import { HealthPage } from "../areas/distribution/HealthPage.js";
import { MatrixPage } from "../areas/distribution/MatrixPage.js";
import { OutletsPage } from "../areas/distribution/OutletsPage.js";
import { RolloutsPage } from "../areas/distribution/RolloutsPage.js";
import { ListingPage } from "../areas/storefronts/ListingPage.js";
import { StorefrontsPage } from "../areas/storefronts/StorefrontsPage.js";
import { FeedsArea } from "../areas/feeds/FeedsArea.js";
import type { SectionPageProps } from "./types.js";

/** Distribution (ADMIN.md §2.3, §6.4): the pages chunk 9 rebuilt on the templates. */
export default function DistributionPages({
  route,
}: SectionPageProps): React.ReactElement | null {
  const { slug } = route;
  switch (route.page) {
    case "matrix":
      return <MatrixPage slug={slug} />;
    case "rollouts":
      return <RolloutsPage slug={slug} />;
    case "outlets":
      return <OutletsPage slug={slug} />;
    case "storefronts":
      return <StorefrontsPage slug={slug} store={route.id} />;
    case "listing":
      return <ListingPage slug={slug} />;
    case "app-store":
      return <AppStorePage slug={slug} />;
    case "commerce":
      return <CommercePage slug={slug} />;
    case "access":
      return <AccessPage slug={slug} />;
    case "health":
      return <HealthPage slug={slug} />;
    case "credentials":
      return <CredentialsPage slug={slug} />;
    case "package-feeds":
      return (
        <FeedsArea
          scope={{ kind: "product", slug }}
          eco={route.id}
          tab={route.tab}
          child={route.child}
        />
      );
    default:
      return null;
  }
}
