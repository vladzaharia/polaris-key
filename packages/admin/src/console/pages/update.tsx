import * as React from "react";
import { UpdateSettings } from "../../views/UpdateSettings.js";
import type { SectionPageProps } from "./types.js";

/** Update: Feed mounts today's Update settings (with delivery access, until chunk 9 moves it). */
export default function UpdatePages({
  route,
}: SectionPageProps): React.ReactElement | null {
  return route.page === "feed" ? <UpdateSettings slug={route.slug} /> : null;
}
