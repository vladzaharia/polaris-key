import * as React from "react";
import { FeedPage } from "./pages/UpdateChannelsPage.js";
import { UpdatesPage } from "./pages/UpdatesPage.js";
import type { SectionPageProps } from "../../pages/types.js";

/** Update (ADMIN.md §2.3): Updates (P2-11) and Feed, rebuilt in chunk 9 (delivery access moved to Distribution). */
export default function UpdatePages({
  route,
}: SectionPageProps): React.ReactElement | null {
  if (route.page === "updaters") return <UpdatesPage slug={route.slug} />;
  return route.page === "feed" ? <FeedPage slug={route.slug} /> : null;
}
