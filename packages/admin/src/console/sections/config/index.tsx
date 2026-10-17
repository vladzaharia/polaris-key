import * as React from "react";
import { ApproveRecipeFromUrl } from "./components/ApproveRecipeDrawer.js";
import { CatalogEditorPage } from "./pages/CatalogEditorPage.js";
import { CatalogPage } from "./pages/CatalogPage.js";
import { ProfilePage } from "./pages/ProfilePage.js";
import { ProfilesPage } from "./pages/ProfilesPage.js";
import type { SectionPageProps } from "../../pages/types.js";

/** Config (docs/design/ADMIN.md §6.6): catalog, catalog editor and profiles. */
export default function ConfigPages({
  route,
}: SectionPageProps): React.ReactElement | null {
  const { slug } = route;
  switch (route.page) {
    case "catalog":
      return <CatalogPage slug={slug} />;
    case "catalog-edit":
      return (
        <>
          <CatalogEditorPage slug={slug} />
          <ApproveRecipeFromUrl slug={slug} />
        </>
      );
    case "profiles":
      return route.id !== undefined ? (
        <ProfilePage slug={slug} id={route.id} tab={route.tab} />
      ) : (
        <ProfilesPage slug={slug} />
      );
    default:
      return null;
  }
}
