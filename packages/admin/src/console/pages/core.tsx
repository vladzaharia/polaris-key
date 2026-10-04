import * as React from "react";
import { ProductOverview } from "../../views/ProductOverview.js";
import { Services } from "../../views/Services.js";
import { Devices } from "../../views/Devices.js";
import { Secrets } from "../../views/Secrets.js";
import { Activity } from "../../views/Activity.js";
import { Settings } from "../../views/Settings.js";
import type { SectionPageProps } from "./types.js";

/** Core: the legacy views mounted at their new URLs (ADMIN.md §2.3), unchanged until chunk 5. */
export default function CorePages({
  route,
}: SectionPageProps): React.ReactElement | null {
  const { slug } = route;
  switch (route.page) {
    case "overview":
      return <ProductOverview slug={slug} />;
    case "services":
      return <Services slug={slug} />;
    case "devices":
      return <Devices slug={slug} />;
    case "keys":
      return <Secrets slug={slug} />;
    case "activity":
      return <Activity slug={slug} />;
    case "settings":
      return <Settings slug={slug} />;
    default:
      return null;
  }
}
