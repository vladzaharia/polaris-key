import * as React from "react";
import { CatalogEditorPage } from "./config/CatalogEditorPage.js";
import { CatalogPage } from "./config/CatalogPage.js";
import { EdgeMintPage } from "./config/EdgeMintPage.js";
import { ProfilePage } from "./config/ProfilePage.js";
import { ProfilesPage } from "./config/ProfilesPage.js";
import type { SectionPageProps } from "./types.js";

/** Config (docs/design/ADMIN.md §6.6): catalog, catalog editor, profiles and edge mint. */
export default function ConfigPages({
  route,
}: SectionPageProps): React.ReactElement | null {
  const { slug } = route;
  switch (route.page) {
    case "catalog":
      return <CatalogPage slug={slug} />;
    case "catalog-edit":
      return <CatalogEditorPage slug={slug} />;
    case "profiles":
      return route.id !== undefined ? (
        <ProfilePage slug={slug} id={route.id} tab={route.tab} />
      ) : (
        <ProfilesPage slug={slug} />
      );
    case "edge-mint":
      return <EdgeMintPage slug={slug} />;
    default:
      return null;
  }
}
