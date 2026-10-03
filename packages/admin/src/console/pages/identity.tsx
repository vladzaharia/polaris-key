import * as React from "react";
import { Identity } from "../../views/Identity.js";
import type { SectionPageProps } from "./types.js";

/** Identity: Portal mounts today's Sign-in & portal view, until chunk 10 splits it. */
export default function IdentityPages({
  route,
}: SectionPageProps): React.ReactElement | null {
  return route.page === "portal" ? <Identity slug={route.slug} /> : null;
}
