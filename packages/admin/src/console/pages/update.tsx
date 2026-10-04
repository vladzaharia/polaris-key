import * as React from "react";
import { FeedPage } from "../areas/update/FeedPage.js";
import type { SectionPageProps } from "./types.js";

/** Update (ADMIN.md §2.3): Feed, rebuilt in chunk 9 (delivery access moved to Distribution). */
export default function UpdatePages({
  route,
}: SectionPageProps): React.ReactElement | null {
  return route.page === "feed" ? <FeedPage slug={route.slug} /> : null;
}
