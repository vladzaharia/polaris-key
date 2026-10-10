import * as React from "react";
import { AccessPage } from "./pages/AccessPage.js";
import { AppStorePage } from "./pages/AppStorePage.js";
import { CommercePage } from "./pages/CommercePage.js";
import { CredentialsPage } from "./pages/CredentialsPage.js";
import { HealthPage } from "./pages/HealthPage.js";
import { MatrixPage } from "./pages/MatrixPage.js";
import { OutletsPage } from "./pages/OutletsPage.js";
import { RolloutsPage } from "./pages/RolloutsPage.js";
import { ListingPage } from "../storefronts/pages/ListingPage.js";
import { StorefrontsPage } from "../storefronts/pages/StorefrontsPage.js";
import { FeedsArea } from "../feeds/pages/FeedsArea.js";
import type { SectionPageProps } from "../../pages/types.js";

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
