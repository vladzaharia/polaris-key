import * as React from "react";
import { AccessPage } from "../areas/distribution/AccessPage.js";
import { CredentialsPage } from "../areas/distribution/CredentialsPage.js";
import { HealthPage } from "../areas/distribution/HealthPage.js";
import { MatrixPage } from "../areas/distribution/MatrixPage.js";
import { OutletsPage } from "../areas/distribution/OutletsPage.js";
import { RolloutsPage } from "../areas/distribution/RolloutsPage.js";
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
    case "access":
      return <AccessPage slug={slug} />;
    case "health":
      return <HealthPage slug={slug} />;
    case "credentials":
      return <CredentialsPage slug={slug} />;
    default:
      return null;
  }
}
