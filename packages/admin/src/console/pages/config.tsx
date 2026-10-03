import * as React from "react";
import { Catalog } from "../../views/Catalog.js";
import { Profiles } from "../../views/Profiles.js";
import { ProfileDetail } from "../../views/profiles/ProfileDetail.js";
import type { SectionPageProps } from "./types.js";

/** Config: the legacy views at their new URLs, unchanged until chunk 7. */
export default function ConfigPages({
  route,
}: SectionPageProps): React.ReactElement | null {
  const { slug } = route;
  switch (route.page) {
    case "catalog":
      return <Catalog slug={slug} />;
    case "profiles":
      return route.id !== undefined ? (
        <ProfileDetail slug={slug} id={route.id} />
      ) : (
        <Profiles slug={slug} />
      );
    default:
      return null;
  }
}
